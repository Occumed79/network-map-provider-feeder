import { getTableColumns } from "./schema.js";

const APP_CANDIDATE_TABLE = process.env.APP_CANDIDATE_TABLE || "provider_candidates";
const ENABLE_APP_CANDIDATE_WRITE = process.env.ENABLE_APP_CANDIDATE_WRITE !== "0";

function has(columns, column) {
  return columns.has(column);
}

function put(values, columns, names, value) {
  for (const name of names) {
    if (has(columns, name) && value !== undefined) {
      values[name] = value;
      return true;
    }
  }
  return false;
}

function hasAny(columns, names) {
  return names.some((name) => columns.has(name));
}

async function tableExists(client, tableName) {
  const { rows } = await client.query("SELECT to_regclass($1::text) AS exists", [`public.${tableName}`]);
  return Boolean(rows[0]?.exists);
}

async function getColumns(client, tableName) {
  const columns = await getTableColumns(tableName);
  if (columns.size) return columns;

  const { rows } = await client.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = $1::text`,
    [tableName]
  );
  return new Set(rows.map((row) => row.column_name));
}

function buildValues({ columns, job, mapped, normalizedName, phone, website, lat, lng, confidence, dedupeKey }) {
  const values = {};
  const name = mapped.title;

  put(values, columns, ["name", "provider_name", "clinic_name", "title"], name);
  put(values, columns, ["normalized_name", "normalized_provider_name", "search_name"], normalizedName);
  put(values, columns, ["country_code", "country"], job.country_code || "US");
  put(values, columns, ["category", "provider_category", "primary_category"], mapped.category);
  put(values, columns, ["service_line", "service_type"], job.service_line);
  put(values, columns, ["address", "full_address", "street_address"], mapped.address);
  put(values, columns, ["phone", "phone_number"], phone || mapped.phone);
  put(values, columns, ["website", "url"], website || mapped.website);
  put(values, columns, ["latitude", "lat"], lat);
  put(values, columns, ["longitude", "lng", "lon"], lng);
  put(values, columns, ["confidence_score", "confidence"], confidence);
  put(values, columns, ["dedupe_key", "external_key", "provider_key"], dedupeKey);
  put(values, columns, ["source", "data_source", "created_by"], "network-map-provider-feeder");
  put(values, columns, ["source_query", "query"], job.query);
  put(values, columns, ["status"], "new");
  put(values, columns, ["raw", "raw_data", "metadata"], mapped.raw ? JSON.stringify(mapped.raw) : null);

  if (has(columns, "created_at")) values.created_at = "__NOW__";
  if (has(columns, "updated_at")) values.updated_at = "__NOW__";

  return values;
}

function buildWhere({ columns, values }) {
  if (has(columns, "dedupe_key") && values.dedupe_key) return { text: "dedupe_key = $1::text", params: [values.dedupe_key] };
  if (has(columns, "external_key") && values.external_key) return { text: "external_key = $1::text", params: [values.external_key] };
  if (hasAny(columns, ["phone", "phone_number"])) {
    const phoneColumn = has(columns, "phone") ? "phone" : "phone_number";
    const phone = values[phoneColumn];
    if (phone) return { text: `${phoneColumn} = $1::text`, params: [phone] };
  }
  if (hasAny(columns, ["website", "url"])) {
    const websiteColumn = has(columns, "website") ? "website" : "url";
    const website = values[websiteColumn];
    if (website) return { text: `${websiteColumn} = $1::text`, params: [website] };
  }
  const nameColumn = ["name", "provider_name", "clinic_name", "title"].find((column) => has(columns, column));
  const addressColumn = ["address", "full_address", "street_address"].find((column) => has(columns, column));
  if (nameColumn && addressColumn && values[nameColumn] && values[addressColumn]) {
    return { text: `lower(${nameColumn}) = lower($1::text) AND lower(${addressColumn}) = lower($2::text)`, params: [values[nameColumn], values[addressColumn]] };
  }
  return null;
}

async function upsertDynamic(client, tableName, columns, values) {
  const entries = Object.entries(values).filter(([column, value]) => columns.has(column) && value !== undefined);
  if (!entries.length) return { action: "skipped", reason: "no_matching_columns" };

  const where = buildWhere({ columns, values });
  if (where) {
    const existing = await client.query(`SELECT id FROM ${tableName} WHERE ${where.text} LIMIT 1`, where.params);
    if (existing.rows.length) {
      const updateEntries = entries.filter(([column]) => !["id", "created_at"].includes(column));
      if (!updateEntries.length) return { action: "existing", id: existing.rows[0].id };
      const params = [];
      const setSql = updateEntries.map(([column, value]) => {
        if (value === "__NOW__") return `${column} = now()`;
        params.push(value);
        return `${column} = COALESCE($${params.length}, ${column})`;
      });
      params.push(existing.rows[0].id);
      await client.query(`UPDATE ${tableName} SET ${setSql.join(", ")} WHERE id = $${params.length}`, params);
      return { action: "updated", id: existing.rows[0].id };
    }
  }

  const params = [];
  const insertColumns = [];
  const placeholders = [];
  for (const [column, value] of entries) {
    insertColumns.push(column);
    if (value === "__NOW__") {
      placeholders.push("now()");
    } else {
      params.push(value);
      placeholders.push(`$${params.length}`);
    }
  }

  const returning = columns.has("id") ? " RETURNING id" : "";
  const inserted = await client.query(
    `INSERT INTO ${tableName} (${insertColumns.join(", ")}) VALUES (${placeholders.join(", ")})${returning}`,
    params
  );
  return { action: "inserted", id: inserted.rows[0]?.id || null };
}

export async function writeAppCandidate(client, payload) {
  if (!ENABLE_APP_CANDIDATE_WRITE) return { action: "disabled" };
  if (!(await tableExists(client, APP_CANDIDATE_TABLE))) return { action: "skipped", reason: `${APP_CANDIDATE_TABLE}_missing` };

  const columns = await getColumns(client, APP_CANDIDATE_TABLE);
  const values = buildValues({ columns, ...payload });
  return upsertDynamic(client, APP_CANDIDATE_TABLE, columns, values);
}
