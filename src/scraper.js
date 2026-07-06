import { logger } from "./logger.js";

const NPI_API_URL = process.env.NPI_API_URL || "https://npiregistry.cms.hhs.gov/api/";
const NPI_VERSION = process.env.NPI_VERSION || "2.1";
const NPI_LIMIT = Math.min(parseInt(process.env.NPI_LIMIT || "50", 10), 200);
const NPI_REQUEST_DELAY_MS = parseInt(process.env.NPI_REQUEST_DELAY_MS || "250", 10);
const NPI_MAX_STRATEGIES = parseInt(process.env.NPI_MAX_STRATEGIES || "6", 10);
const ENABLE_CENSUS_GEOCODING = process.env.ENABLE_CENSUS_GEOCODING !== "0";
const MAX_GEOCODES_PER_JOB = parseInt(process.env.MAX_GEOCODES_PER_JOB || "10", 10);
const CENSUS_GEOCODER_URL = process.env.CENSUS_GEOCODER_URL || "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress";
const CENSUS_BENCHMARK = process.env.CENSUS_BENCHMARK || "Public_AR_Current";

const SERVICE_TERMS = {
  occupational_health: ["occupational", "industrial", "employee", "work", "healthworks", "workwell", "concentra"],
  occupational_medicine: ["occupational", "industrial", "medicine", "work", "concentra", "healthworks"],
  pre_employment: ["occupational", "employee", "pre employment", "work", "urgent", "concentra"],
  dot_physical: ["dot", "occupational", "urgent", "concentra", "medexpress", "afc"],
  workers_comp: ["workers", "worker", "occupational", "industrial", "work", "concentra"],
  physical_ability: ["occupational", "industrial", "work", "physical", "concentra", "workwell"],
  occupational_audiogram: ["occupational", "industrial", "audiology", "hearing", "work", "concentra"],
  occupational_spirometry: ["occupational", "industrial", "pulmonary", "respiratory", "work", "concentra"],
};

const TAXONOMY_STRATEGIES = {
  occupational_health: ["Clinic/Center", "Occupational Medicine"],
  occupational_medicine: ["Occupational Medicine", "Clinic/Center"],
  pre_employment: ["Clinic/Center", "Urgent Care"],
  dot_physical: ["Clinic/Center", "Urgent Care"],
  workers_comp: ["Clinic/Center", "Occupational Medicine"],
  physical_ability: ["Clinic/Center", "Physical Medicine & Rehabilitation"],
  occupational_audiogram: ["Audiologist", "Clinic/Center"],
  occupational_spirometry: ["Clinic/Center", "Pulmonary Disease"],
};

const geocodeCache = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function titleCase(value) {
  const cleaned = normalizeWhitespace(value);
  if (!cleaned) return null;
  return cleaned
    .toLowerCase()
    .replace(/\b([a-z])/g, (match) => match.toUpperCase())
    .replace(/\b(Llc|Inc|Pllc|Pa|Pc|Md|Dds|Do|Npi|Usa|Afc)\b/g, (match) => match.toUpperCase());
}

function parseCityState(query) {
  const match = normalizeWhitespace(query).match(/\bin\s+(.+?)\s+([A-Z]{2})\s*$/i);
  if (!match) return { city: null, state: null };
  return { city: titleCase(match[1]), state: match[2].toUpperCase() };
}

function uniq(values) {
  return [...new Set(values.filter(Boolean).map((value) => normalizeWhitespace(value)).filter(Boolean))];
}

async function fetchJson(url, { timeoutMs = 30000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: "application/json",
        "user-agent": "network-map-provider-feeder/2.0 (+https://github.com/Occumed79/network-map-provider-feeder)",
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function npiUrl(params) {
  const url = new URL(NPI_API_URL);
  url.searchParams.set("version", NPI_VERSION);
  url.searchParams.set("enumeration_type", "NPI-2");
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

function buildStrategies({ query, serviceLine, city, state }) {
  const queryTokens = normalizeWhitespace(query)
    .toLowerCase()
    .replace(/\bin\s+.+?\s+[a-z]{2}$/i, "")
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !["clinic", "health", "physical"].includes(token));

  const serviceTerms = SERVICE_TERMS[serviceLine] || SERVICE_TERMS.occupational_health;
  const taxonomyTerms = TAXONOMY_STRATEGIES[serviceLine] || TAXONOMY_STRATEGIES.occupational_health;
  const organizationTerms = uniq([...serviceTerms, ...queryTokens]).slice(0, NPI_MAX_STRATEGIES);

  const strategies = [];
  for (const term of organizationTerms) {
    strategies.push({ organization_name: term, city, state });
  }
  for (const taxonomy of taxonomyTerms) {
    strategies.push({ taxonomy_description: taxonomy, city, state });
  }

  if (state && !city) {
    for (const term of organizationTerms.slice(0, 3)) strategies.push({ organization_name: term, state });
  }

  const seen = new Set();
  return strategies.filter((strategy) => {
    const key = JSON.stringify(strategy);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function chooseLocationAddress(result) {
  const addresses = Array.isArray(result.addresses) ? result.addresses : [];
  return (
    addresses.find((address) => address.address_purpose === "LOCATION") ||
    addresses.find((address) => address.address_type === "DOM") ||
    addresses[0] ||
    null
  );
}

function formatAddress(address) {
  if (!address) return null;
  const street = [address.address_1, address.address_2].map(normalizeWhitespace).filter(Boolean).join(" ");
  return [street, address.city, address.state, address.postal_code].map(normalizeWhitespace).filter(Boolean).join(", ") || null;
}

function primaryTaxonomy(result) {
  const taxonomies = Array.isArray(result.taxonomies) ? result.taxonomies : [];
  return taxonomies.find((taxonomy) => taxonomy.primary) || taxonomies[0] || null;
}

function taxonomyCategories(result) {
  const taxonomies = Array.isArray(result.taxonomies) ? result.taxonomies : [];
  return taxonomies.map((taxonomy) => taxonomy.desc || taxonomy.description || taxonomy.code).filter(Boolean);
}

function relevanceText(result) {
  const basic = result.basic || {};
  const address = chooseLocationAddress(result);
  return [
    basic.organization_name,
    basic.authorized_official_organization_name,
    primaryTaxonomy(result)?.desc,
    taxonomyCategories(result).join(" "),
    address?.city,
    address?.state,
  ].map(normalizeWhitespace).join(" ").toLowerCase();
}

function isRelevant(result, serviceLine) {
  const text = relevanceText(result);
  const serviceTerms = SERVICE_TERMS[serviceLine] || SERVICE_TERMS.occupational_health;
  if (serviceTerms.some((term) => text.includes(term.toLowerCase()))) return true;
  if (text.includes("occupational medicine")) return true;
  if (text.includes("urgent care")) return ["dot_physical", "pre_employment"].includes(serviceLine);
  return false;
}

async function geocodeAddress(address) {
  if (!ENABLE_CENSUS_GEOCODING || !address) return null;
  const key = address.toLowerCase();
  if (geocodeCache.has(key)) return geocodeCache.get(key);

  const url = new URL(CENSUS_GEOCODER_URL);
  url.searchParams.set("address", address);
  url.searchParams.set("benchmark", CENSUS_BENCHMARK);
  url.searchParams.set("format", "json");

  try {
    const payload = await fetchJson(url, { timeoutMs: 15000 });
    const match = payload?.result?.addressMatches?.[0];
    const coordinates = match?.coordinates;
    const value = coordinates?.x != null && coordinates?.y != null
      ? { latitude: Number(coordinates.y), longitude: Number(coordinates.x), matchedAddress: match.matchedAddress }
      : null;
    geocodeCache.set(key, value);
    return value;
  } catch (err) {
    logger.warn("Census geocode failed", { address, error: err.message });
    geocodeCache.set(key, null);
    return null;
  }
}

async function normalizeNpiResult(result, { query, serviceLine, geo, geocodeBudget }) {
  const basic = result.basic || {};
  const address = chooseLocationAddress(result);
  const formattedAddress = formatAddress(address);
  const taxonomy = primaryTaxonomy(result);
  let geocode = null;

  if (geocodeBudget.remaining > 0 && formattedAddress) {
    geocodeBudget.remaining -= 1;
    geocode = await geocodeAddress(formattedAddress);
    if (NPI_REQUEST_DELAY_MS > 0) await sleep(Math.min(NPI_REQUEST_DELAY_MS, 1100));
  }

  return {
    title: titleCase(basic.organization_name) || titleCase(basic.authorized_official_organization_name),
    category: taxonomy?.desc || taxonomy?.description || "NPI Organization",
    categories: taxonomyCategories(result),
    address: formattedAddress,
    phone: address?.telephone_number || null,
    fax: address?.fax_number || null,
    website: null,
    latitude: geocode?.latitude ?? null,
    longitude: geocode?.longitude ?? null,
    place_id: result.number ? `npi:${result.number}` : null,
    google_place_id: result.number ? `npi:${result.number}` : null,
    npi: result.number || null,
    service_line: serviceLine,
    source: "npi_registry",
    source_query: query,
    matched_address: geocode?.matchedAddress || null,
    location_precision: geocode ? "census_address" : geo ? "city_job_without_exact_address_geocode" : "none",
    raw_npi: result,
  };
}

async function fetchNpiStrategy(strategy, { page, limit }) {
  const url = npiUrl({ ...strategy, limit, skip: page * limit });
  logger.info("Fetching NPI Registry page", {
    strategy,
    page,
    limit,
  });
  return await fetchJson(url, { timeoutMs: 30000 });
}

export async function runScraper({
  query,
  depth = 1,
  serviceLine = null,
  city = null,
  state = null,
  geo = null,
}) {
  const parsed = parseCityState(query);
  const effectiveCity = city || parsed.city;
  const effectiveState = (state || parsed.state || "").toUpperCase() || null;
  const effectiveServiceLine = serviceLine || "occupational_health";
  const pagesPerStrategy = Math.max(1, Math.min(parseInt(depth || "1", 10), 5));
  const strategies = buildStrategies({
    query,
    serviceLine: effectiveServiceLine,
    city: effectiveCity,
    state: effectiveState,
  });

  logger.info("Starting HTTP-only NPI feeder", {
    query,
    serviceLine: effectiveServiceLine,
    city: effectiveCity,
    state: effectiveState,
    strategies: strategies.length,
    pagesPerStrategy,
    limit: NPI_LIMIT,
    geocoding: ENABLE_CENSUS_GEOCODING,
  });

  const seen = new Set();
  const normalized = [];
  const geocodeBudget = { remaining: MAX_GEOCODES_PER_JOB };

  for (const strategy of strategies) {
    for (let page = 0; page < pagesPerStrategy; page += 1) {
      let payload;
      try {
        payload = await fetchNpiStrategy(strategy, { page, limit: NPI_LIMIT });
      } catch (err) {
        logger.warn("NPI Registry request failed", { strategy, page, error: err.message });
        continue;
      }

      const results = Array.isArray(payload?.results) ? payload.results : [];
      for (const result of results) {
        if (!result?.number || seen.has(result.number)) continue;
        seen.add(result.number);
        if (!isRelevant(result, effectiveServiceLine)) continue;
        const mapped = await normalizeNpiResult(result, {
          query,
          serviceLine: effectiveServiceLine,
          geo,
          geocodeBudget,
        });
        if (mapped.title) normalized.push(mapped);
      }

      if (results.length < NPI_LIMIT) break;
      if (NPI_REQUEST_DELAY_MS > 0) await sleep(NPI_REQUEST_DELAY_MS);
    }
  }

  logger.info("HTTP-only NPI feeder completed", { query, resultCount: normalized.length, seen: seen.size });
  return normalized;
}
