/**
 * Normalization helpers for provider candidate deduplication.
 */

// Strip everything but digits; keep leading 1 for US numbers
export function normalizePhone(phone) {
  if (!phone) return null;
  let digits = phone.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) {
    return digits;
  }
  if (digits.length === 10) {
    return "1" + digits;
  }
  return digits || null;
}

// Extract domain, lowercase, strip www. and trailing path
export function normalizeWebsite(website) {
  if (!website) return null;
  try {
    let url = website.trim().toLowerCase();
    if (!url.startsWith("http")) url = "https://" + url;
    const u = new URL(url);
    let host = u.hostname.replace(/^www\./, "");
    return host || null;
  } catch {
    return null;
  }
}

// Lowercase, collapse whitespace, remove common suffixes
export function normalizeName(name) {
  if (!name) return null;
  let n = name
    .toLowerCase()
    .replace(/\b(llc|inc|corp|ltd|co|pllc|pc|pa|group|clinic|center|centre)\b\.?/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return n || null;
}

export function normalizeLat(lat) {
  const v = parseFloat(lat);
  return isNaN(v) ? null : Math.round(v * 1e6) / 1e6;
}

export function normalizeLng(lng) {
  const v = parseFloat(lng);
  return isNaN(v) ? null : Math.round(v * 1e6) / 1e6;
}

// Haversine distance in meters
export function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Levenshtein-based similarity ratio (0–1)
function nameSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const longer = a.length >= b.length ? a : b;
  const shorter = a.length >= b.length ? b : a;
  const dist = levenshtein(longer, shorter);
  return 1 - dist / longer.length;
}

function levenshtein(a, b) {
  const m = [];
  for (let i = 0; i <= b.length; i++) m[i] = [i];
  for (let j = 0; j <= a.length; j++) m[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b[i - 1] === a[j - 1]) m[i][j] = m[i - 1][j - 1];
      else m[i][j] = Math.min(m[i - 1][j - 1], m[i][j - 1], m[i - 1][j]) + 1;
    }
  }
  return m[b.length][a.length];
}

/**
 * Compute a dedupe key for a raw result.
 * Priority: google_place_id > google_cid > phone > website > name+address
 */
export function computeDedupeKey(raw) {
  if (raw.google_place_id) return `place:${raw.google_place_id}`;
  if (raw.google_cid) return `cid:${raw.google_cid}`;
  const phone = normalizePhone(raw.phone);
  if (phone) return `phone:${phone}`;
  const website = normalizeWebsite(raw.website);
  if (website) return `web:${website}`;
  const name = normalizeName(raw.title);
  const addr = (raw.address || "").toLowerCase().trim();
  if (name && addr) return `nameaddr:${name}|${addr}`;
  return `name:${name || "unknown"}`;
}

/**
 * Determine whether a raw result is a near-duplicate of an existing candidate
 * using lat/lon proximity + name similarity.
 */
export function isNearbyDuplicate(raw, existing) {
  if (
    raw.latitude == null ||
    raw.longitude == null ||
    existing.latitude == null ||
    existing.longitude == null
  )
    return false;

  const dist = distanceMeters(
    raw.latitude,
    raw.longitude,
    existing.latitude,
    existing.longitude
  );
  if (dist > 200) return false; // 200m threshold

  const sim = nameSimilarity(
    normalizeName(raw.title),
    normalizeName(existing.name)
  );
  return sim >= 0.7;
}

/**
 * Compute a confidence score (0–1) based on data completeness.
 */
export function computeConfidence(raw) {
  let score = 0;
  if (raw.title) score += 0.15;
  if (raw.address) score += 0.15;
  if (raw.phone) score += 0.15;
  if (raw.website) score += 0.15;
  if (raw.latitude != null && raw.longitude != null) score += 0.15;
  if (raw.google_place_id) score += 0.15;
  if (raw.review_count && raw.review_count > 0) score += 0.1;
  if (raw.review_rating && raw.review_rating > 0) score += 0.1;
  return Math.min(score, 1);
}
