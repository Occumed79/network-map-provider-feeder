import { query } from "./db.js";
import { logger } from "./logger.js";

const columnCache = new Map();

export async function getTableColumns(tableName) {
  if (columnCache.has(tableName)) return columnCache.get(tableName);

  const { rows } = await query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = $1`,
    [tableName]
  );

  const columns = new Set(rows.map((row) => row.column_name));
  columnCache.set(tableName, columns);
  return columns;
}

export async function validateSchema() {
  const requiredTables = [
    "provider_feeder_jobs",
    "google_maps_raw_results",
    "provider_feeder_candidates",
    "provider_feeder_candidate_sources",
    "provider_feeder_runs",
  ];

  const missingTables = [];
  for (const tableName of requiredTables) {
    const { rows } = await query(`SELECT to_regclass($1) AS exists`, [`public.${tableName}`]);
    if (!rows[0]?.exists) missingTables.push(tableName);
  }

  if (missingTables.length) {
    throw new Error(`Neon schema is missing required feeder tables: ${missingTables.join(", ")}`);
  }

  const jobsColumns = await getTableColumns("provider_feeder_jobs");
  const requiredJobColumns = ["id", "query", "status", "attempts", "max_attempts", "priority", "created_at"];
  const missingJobColumns = requiredJobColumns.filter((column) => !jobsColumns.has(column));
  if (missingJobColumns.length) {
    throw new Error(`provider_feeder_jobs is missing required columns: ${missingJobColumns.join(", ")}`);
  }

  logger.info("Read-only Neon schema validation passed", { tables: requiredTables.length });
}
