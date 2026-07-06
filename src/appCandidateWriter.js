import { logger } from "./logger.js";
import { getTableColumns } from "./schema.js";

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DEFAULT_TABLE = "provider_candidates";

function configuredTable() {
  return process.env.APP_CANDIDATE_TABLE || DEFAULT_TABLE;
}

export function appCandidateWritesEnabled() {
  return process.env.ENABLE_APP_CANDIDATE_WRITE === "1";
}

export function isValidSqlIdentifier(value) {
  return IDENTIFIER_RE.test(value || "");
}

function quoted(name) {
  if (!isValidSqlIdentifier(name)) throw new Error(`Invalid SQL identifier: ${name}`);
  return `"${name}"`;
}

function firstColumn(columns, names) {
  return names.find((name) => columns.has(name));
}

function put(values, columns, names, value) {
  const column = firstColumn(columns, names);
  if (!column || value === undefined || value === null || value === "") return false;
  values[column] = value;
  return true;
}

async function tableExists(client, tableName) {
  const { rows } = await client.query("SELECT to_regclass($1::text) AS regclass", [`public.${tableName}`]);
  return Boolean(rows[0]?.regclass);
}

async function getColumns(client, tableName) {
  const cached = await getTableColumns(tableName);
  if (cached.size) return cached;
  const { rows } = await client.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1::text`,
    [tableName]
  );
  return new Set(rows.map((row) => row.column_name));
}

function buildValues({ columns, job, mapped, normalizedName, phone, website, lat, lng, confidence, dedupeKey }) {
  const values = {};
  put(values, columns, ["name", "provider_name", "clinic_name", "title"], mapped.title);
  put(values, columns, ["normalized_name", "normalized_provider_name", "search_name"], normalizedName);
  put(values, columns, ["address", "full_address", "street_address"], mapped.address);
  put(values, columns, ["phone", "phone_number"], phone || mapped.phone);
  put(values, columns, ["website", "url"], website || mapped.website);
  put(values, columns, ["latitude", "lat"], lat);
  put(values, columns, ["longitude", "lng", "lon"], lng);
  put(values, columns, ["category", "provider_category", "primary_category", "service_line", "service_type"], mapped.category || job.service_line);
  put(values, columns, ["dedupe_key", "external_key", "provider_key"], dedupeKey);
  put(values, columns, ["source", "data_source", "created_by"], "network-map-provider-feeder");
  put(values, columns, ["source_query", "query"], job.query);
  put(values, columns, ["raw", "raw_data", "metadata"], JSON.stringify({ ...mapped.raw, feeder: { jobId: job.id, query: job.query } }));
  put(values, columns, ["confidence_score", "confidence"], confidence);
  put(values, columns, ["status"], "new");
  if (columns.has("created_at")) values.created_at = "__NOW__";
  if (columns.has("updated_at")) values.updated_at = "__NOW__";
  return values;
}

function whereClauses(columns, values) {
  const byKey = firstColumn(columns, ["dedupe_key", "external_key", "provider_key"]);
  if (byKey && values[byKey]) return { text: `${quoted(byKey)} = $1`, params: [values[byKey]] };
  const phone = firstColumn(columns, ["phone", "phone_number"]);
  if (phone && values[phone]) return { text: `${quoted(phone)} = $1`, params: [values[phone]] };
  const web = firstColumn(columns, ["website", "url"]);
  if (web && values[web]) return { text: `${quoted(web)} = $1`, params: [values[web]] };
  const name = firstColumn(columns, ["normalized_name", "normalized_provider_name", "search_name", "name", "provider_name", "clinic_name", "title"]);
  const addr = firstColumn(columns, ["address", "full_address", "street_address"]);
  if (name && addr && values[name] && values[addr]) return { text: `lower(${quoted(name)}) = lower($1) AND lower(${quoted(addr)}) = lower($2)`, params: [values[name], values[addr]] };
  const title = firstColumn(columns, ["name", "provider_name", "clinic_name", "title"]);
  const lat = firstColumn(columns, ["latitude", "lat"]);
  const lng = firstColumn(columns, ["longitude", "lng", "lon"]);
  if (title && lat && lng && values[title] && values[lat] != null && values[lng] != null) return { text: `lower(${quoted(title)}) = lower($1) AND ${quoted(lat)} = $2 AND ${quoted(lng)} = $3`, params: [values[title], values[lat], values[lng]] };
  return null;
}

async function upsertDynamic(client, tableName, columns, values) {
  const entries = Object.entries(values).filter(([column, value]) => columns.has(column) && value !== undefined);
  if (!entries.length) return { action: "skipped", reason: "no_matching_columns" };
  const tableSql = quoted(tableName);
  const where = whereClauses(columns, values);
  if (where) {
    const idCol = columns.has("id") ? "id" : null;
    const existing = await client.query(`SELECT ${idCol ? quoted(idCol) : "1 AS found"} FROM ${tableSql} WHERE ${where.text} LIMIT 1`, where.params);
    if (existing.rows.length) {
      const set = [];
      const params = [];
      for (const [column, value] of entries) {
        if (["id", "created_at"].includes(column)) continue;
        if (value === "__NOW__") {
          set.push(`${quoted(column)} = now()`);
        } else {
          params.push(value);
          if (["confidence_score", "confidence"].includes(column)) {
            set.push(`${quoted(column)} = GREATEST(COALESCE(${quoted(column)}, 0), $${params.length})`);
          } else {
            set.push(`${quoted(column)} = CASE WHEN ${quoted(column)} IS NULL OR ${quoted(column)}::text = '' THEN $${params.length} ELSE ${quoted(column)} END`);
          }
        }
      }
      if (set.length && idCol) {
        params.push(existing.rows[0][idCol]);
        await client.query(`UPDATE ${tableSql} SET ${set.join(", ")} WHERE ${quoted(idCol)} = $${params.length}`, params);
      }
      return { action: "updated" };
    }
  }
  const params = [];
  const cols = [];
  const placeholders = [];
  for (const [column, value] of entries) {
    cols.push(quoted(column));
    if (value === "__NOW__") placeholders.push("now()");
    else { params.push(value); placeholders.push(`$${params.length}`); }
  }
  await client.query(`INSERT INTO ${tableSql} (${cols.join(", ")}) VALUES (${placeholders.join(", ")})`, params);
  return { action: "inserted" };
}

export async function writeAppCandidate(client, payload) {
  if (!appCandidateWritesEnabled()) return { action: "disabled", available: false };
  const tableName = configuredTable();
  if (!isValidSqlIdentifier(tableName)) return { action: "skipped", available: false, reason: "invalid_app_candidate_table" };
  try {
    if (!(await tableExists(client, tableName))) return { action: "skipped", available: false, reason: `${tableName}_missing` };
    const columns = await getColumns(client, tableName);
    const values = buildValues({ columns, ...payload });
    return { ...(await upsertDynamic(client, tableName, columns, values)), available: true };
  } catch (err) {
    logger.warn("App candidate write skipped", { tableName, error: err.message });
    return { action: "skipped", available: false, reason: err.message };
  }
}
