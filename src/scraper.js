import { logger } from "./logger.js";

const MAP_SOURCE = (process.env.MAP_SOURCE || "bing").trim().toLowerCase();
const MAP_HTTP_TIMEOUT_MS = parseInt(process.env.MAP_HTTP_TIMEOUT_MS || "30000", 10);
const MAP_HTTP_USER_AGENT = process.env.MAP_HTTP_USER_AGENT ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";
const MAX_RESULTS_PER_JOB = parseInt(process.env.MAX_RESULTS_PER_JOB || "40", 10);
const REQUEST_DELAY_MS = parseInt(process.env.MAP_HTTP_REQUEST_DELAY_MS || "750", 10);
const ENABLE_SOURCE_FALLBACK = process.env.ENABLE_MAP_SOURCE_FALLBACK !== "0";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function decodeHtml(value) {
  return normalizeWhitespace(String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\\u0026/g, "&")
    .replace(/\\u003d/g, "=")
    .replace(/\\u003c/g, "<")
    .replace(/\\u003e/g, ">")
    .replace(/\\"/g, '"'));
}

function cleanValue(value) {
  const cleaned = decodeHtml(value)
    .replace(/^https?:\/\/www\.bing\.com\/ck\/a\?!&&p=/i, "")
    .replace(/^[|,;:\-\s]+|[|,;:\-\s]+$/g, "");
  return cleaned || null;
}

function uniqBy(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function parseLatLngFromChunk(chunk) {
  const patterns = [
    /"(?:latitude|lat|y)"\s*:\s*(-?\d+(?:\.\d+)?)[^{}]{0,180}"(?:longitude|lng|lon|x)"\s*:\s*(-?\d+(?:\.\d+)?)/i,
    /"(?:longitude|lng|lon|x)"\s*:\s*(-?\d+(?:\.\d+)?)[^{}]{0,180}"(?:latitude|lat|y)"\s*:\s*(-?\d+(?:\.\d+)?)/i,
    /\b(?:lat|latitude)[=:](-?\d+(?:\.\d+)?).*?\b(?:lng|lon|longitude)[=:](-?\d+(?:\.\d+)?)/i,
  ];
  for (let i = 0; i < patterns.length; i += 1) {
    const match = chunk.match(patterns[i]);
    if (!match) continue;
    if (i === 1) return { latitude: Number(match[2]), longitude: Number(match[1]) };
    return { latitude: Number(match[1]), longitude: Number(match[2]) };
  }
  return { latitude: null, longitude: null };
}

function findFirst(chunk, patterns) {
  for (const pattern of patterns) {
    const match = chunk.match(pattern);
    if (match?.[1]) return cleanValue(match[1]);
  }
  return null;
}

function buildBingMapsUrl(query, geo, radiusMeters) {
  const url = new URL("https://www.bing.com/maps");
  url.searchParams.set("q", query);
  url.searchParams.set("FORM", "HDRSC6");
  url.searchParams.set("cp", geo?.lat != null && geo?.lng != null ? `${geo.lat}~${geo.lng}` : "");
  if (radiusMeters) url.searchParams.set("lvl", "12");
  return url;
}

function buildGoogleMapsUrl(query, geo) {
  const safeQuery = encodeURIComponent(query.replace(/\s+/g, " ").trim());
  const center = geo?.lat != null && geo?.lng != null ? `/@${geo.lat},${geo.lng},12z` : "";
  return new URL(`https://www.google.com/maps/search/${safeQuery}${center}?hl=en`);
}

function buildAppleMapsUrl(query, geo) {
  const url = new URL("https://maps.apple.com/");
  url.searchParams.set("q", query);
  if (geo?.lat != null && geo?.lng != null) url.searchParams.set("ll", `${geo.lat},${geo.lng}`);
  return url;
}

function buildSourceUrl(source, query, geo, radiusMeters) {
  if (source === "google") return buildGoogleMapsUrl(query, geo);
  if (source === "apple") return buildAppleMapsUrl(query, geo);
  return buildBingMapsUrl(query, geo, radiusMeters);
}

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MAP_HTTP_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
        "cache-control": "no-cache",
        "user-agent": MAP_HTTP_USER_AGENT,
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${url.hostname}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function extractJsonLd(html, source) {
  const rows = [];
  const scriptRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = scriptRe.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(decodeHtml(match[1]));
      const candidates = Array.isArray(parsed) ? parsed : [parsed];
      for (const candidate of candidates) {
        const type = Array.isArray(candidate["@type"]) ? candidate["@type"].join(" ") : candidate["@type"];
        if (!/LocalBusiness|MedicalBusiness|Organization|Place/i.test(type || "")) continue;
        const address = typeof candidate.address === "string"
          ? candidate.address
          : [candidate.address?.streetAddress, candidate.address?.addressLocality, candidate.address?.addressRegion, candidate.address?.postalCode]
              .filter(Boolean)
              .join(", ");
        rows.push({
          title: cleanValue(candidate.name),
          category: cleanValue(type) || `${source} Maps result`,
          categories: [cleanValue(type) || `${source} Maps result`],
          address: cleanValue(address),
          phone: cleanValue(candidate.telephone),
          website: cleanValue(candidate.url),
          latitude: candidate.geo?.latitude != null ? Number(candidate.geo.latitude) : null,
          longitude: candidate.geo?.longitude != null ? Number(candidate.geo.longitude) : null,
          place_id: cleanValue(candidate["@id"] || candidate.url || candidate.name),
          source,
          raw: candidate,
        });
      }
    } catch {
      // ignore malformed embedded JSON-LD
    }
  }
  return rows;
}

function chunkAroundMatches(html, needles) {
  const chunks = [];
  for (const needle of needles) {
    const re = new RegExp(needle, "gi");
    let match;
    while ((match = re.exec(html)) !== null) {
      const start = Math.max(0, match.index - 2500);
      const end = Math.min(html.length, match.index + 3500);
      chunks.push(html.slice(start, end));
      if (chunks.length >= 250) return chunks;
    }
  }
  return chunks;
}

function extractLooseMapResults(html, source) {
  const chunks = chunkAroundMatches(html, [
    "entityTitle",
    "businessName",
    "formattedAddress",
    "PhoneNumber",
    "phoneNumber",
    "LocalBusiness",
    "maps\/api\/place",
    "place_id",
    "cid",
  ]);

  const results = [];
  for (const chunk of chunks) {
    const title = findFirst(chunk, [
      /"entityTitle"\s*:\s*"([^"]{2,160})"/i,
      /"businessName"\s*:\s*"([^"]{2,160})"/i,
      /"displayName"\s*:\s*"([^"]{2,160})"/i,
      /"title"\s*:\s*"([^"]{2,160})"/i,
      /"name"\s*:\s*"([^"]{2,160})"/i,
      /aria-label="([^"]{2,160})"/i,
    ]);
    if (!title || /^(http|maps|directions|save|share|nearby|reviews?)$/i.test(title)) continue;

    const address = findFirst(chunk, [
      /"formattedAddress"\s*:\s*"([^"]{4,240})"/i,
      /"address"\s*:\s*"([^"]{4,240})"/i,
      /"AddressLine"\s*:\s*"([^"]{4,240})"/i,
      /"streetAddress"\s*:\s*"([^"]{4,240})"/i,
    ]);
    const phone = findFirst(chunk, [
      /"phoneNumber"\s*:\s*"([^"]{7,40})"/i,
      /"PhoneNumber"\s*:\s*"([^"]{7,40})"/i,
      /"telephone"\s*:\s*"([^"]{7,40})"/i,
      /tel:([+\d\-().\s]{7,40})/i,
    ]);
    const website = findFirst(chunk, [
      /"website"\s*:\s*"([^"]{8,300})"/i,
      /"Website"\s*:\s*"([^"]{8,300})"/i,
      /"url"\s*:\s*"(https?:\/\/[^"]{8,300})"/i,
    ]);
    const category = findFirst(chunk, [
      /"category"\s*:\s*"([^"]{2,120})"/i,
      /"primaryCategory"\s*:\s*"([^"]{2,120})"/i,
      /"businessType"\s*:\s*"([^"]{2,120})"/i,
    ]);
    const placeId = findFirst(chunk, [
      /"place_id"\s*:\s*"([^"]{4,180})"/i,
      /"placeId"\s*:\s*"([^"]{4,180})"/i,
      /"entityId"\s*:\s*"([^"]{4,180})"/i,
      /"cid"\s*:\s*"?([\d-]{4,40})"?/i,
    ]);
    const coords = parseLatLngFromChunk(chunk);

    results.push({
      title,
      category: category || `${source} Maps result`,
      categories: [category || `${source} Maps result`],
      address,
      phone,
      website,
      latitude: coords.latitude,
      longitude: coords.longitude,
      place_id: placeId || `${source}:${title}:${address || ""}`,
      source,
      raw: { source, title, address, phone, website, category, placeId, extractedChunk: chunk.slice(0, 1200) },
    });
  }

  return results;
}

function scoreResult(result, query) {
  const q = query.toLowerCase();
  const text = [result.title, result.category, result.address, result.website].filter(Boolean).join(" ").toLowerCase();
  let score = 0;
  for (const term of ["occupational", "clinic", "medical", "urgent", "health", "workers", "dot", "physical", "audiogram", "spirometry"]) {
    if (q.includes(term) && text.includes(term)) score += 2;
  }
  if (result.phone) score += 1;
  if (result.address) score += 2;
  if (result.latitude != null && result.longitude != null) score += 2;
  if (result.website) score += 1;
  return score;
}

function normalizeResults(results, { query, source }) {
  const filtered = results
    .filter((result) => result.title)
    .map((result) => ({
      ...result,
      source: `${source}_maps_http`,
      google_place_id: result.place_id || null,
      google_cid: result.google_cid || null,
      review_rating: result.review_rating || null,
      review_count: result.review_count || null,
      open_hours: result.open_hours || null,
      source_query: query,
    }))
    .filter((result) => scoreResult(result, query) >= 1)
    .sort((a, b) => scoreResult(b, query) - scoreResult(a, query));

  return uniqBy(filtered, (result) => `${result.title}|${result.address || result.phone || result.website || result.place_id}`.toLowerCase())
    .slice(0, MAX_RESULTS_PER_JOB);
}

async function scrapeSource(source, { query, geo, radiusMeters }) {
  const url = buildSourceUrl(source, query, geo, radiusMeters);
  logger.info("Fetching mapped source", { source, query, url: url.toString() });
  const html = await fetchText(url);
  const rows = [...extractJsonLd(html, source), ...extractLooseMapResults(html, source)];
  const results = normalizeResults(rows, { query, source });
  logger.info("Mapped source parsed", { source, query, parsed: rows.length, accepted: results.length });
  return results;
}

function sourceOrder() {
  const requested = MAP_SOURCE === "google" || MAP_SOURCE === "apple" || MAP_SOURCE === "bing" ? MAP_SOURCE : "bing";
  if (!ENABLE_SOURCE_FALLBACK) return [requested];
  return [requested, ...["bing", "google", "apple"].filter((source) => source !== requested)];
}

export async function runScraper({ query, geo = null, radiusMeters = null }) {
  const errors = [];
  for (const source of sourceOrder()) {
    try {
      const results = await scrapeSource(source, { query, geo, radiusMeters });
      if (results.length) {
        logger.info("Mapped HTTP scraper completed", { query, source, resultCount: results.length });
        return results;
      }
      errors.push(`${source}: no accepted mapped results`);
    } catch (err) {
      errors.push(`${source}: ${err.message}`);
      logger.warn("Mapped source failed", { source, query, error: err.message });
    }
    if (REQUEST_DELAY_MS > 0) await sleep(REQUEST_DELAY_MS);
  }

  logger.warn("Mapped HTTP scraper returned no results", { query, errors });
  return [];
}
