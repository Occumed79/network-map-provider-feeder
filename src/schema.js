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

export async function ensureFeederSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS provider_feeder_jobs (
      id BIGSERIAL PRIMARY KEY,
      query TEXT NOT NULL,
      country_code VARCHAR(2) NOT NULL DEFAULT 'US',
      region_name TEXT,
      service_line TEXT,
      source TEXT NOT NULL DEFAULT 'manual',
      status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','completed','failed')),
      priority INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      error TEXT,
      target_lat DOUBLE PRECISION,
      target_lng DOUBLE PRECISION,
      radius_meters INTEGER,
      scraper_depth INTEGER NOT NULL DEFAULT 1,
      scraper_fast_mode BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS google_maps_raw_results (
      id BIGSERIAL PRIMARY KEY,
      job_id BIGINT REFERENCES provider_feeder_jobs(id) ON DELETE CASCADE,
      query TEXT,
      country_code VARCHAR(2) DEFAULT 'US',
      title TEXT,
      category TEXT,
      categories JSONB,
      address TEXT,
      phone TEXT,
      website TEXT,
      latitude DOUBLE PRECISION,
      longitude DOUBLE PRECISION,
      google_place_id TEXT,
      google_cid TEXT,
      review_rating DOUBLE PRECISION,
      review_count INTEGER,
      open_hours JSONB,
      raw JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS provider_feeder_candidates (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      normalized_name TEXT NOT NULL,
      country_code VARCHAR(2) NOT NULL DEFAULT 'US',
      category TEXT,
      address TEXT,
      phone TEXT,
      website TEXT,
      latitude DOUBLE PRECISION,
      longitude DOUBLE PRECISION,
      confidence_score DOUBLE PRECISION NOT NULL DEFAULT 0,
      status VARCHAR(20) NOT NULL DEFAULT 'new' CHECK (status IN ('new','verified','rejected','merged')),
      dedupe_key TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS provider_feeder_candidate_sources (
      id BIGSERIAL PRIMARY KEY,
      candidate_id BIGINT NOT NULL REFERENCES provider_feeder_candidates(id) ON DELETE CASCADE,
      raw_result_id BIGINT NOT NULL REFERENCES google_maps_raw_results(id) ON DELETE CASCADE,
      job_id BIGINT REFERENCES provider_feeder_jobs(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS provider_feeder_runs (
      id BIGSERIAL PRIMARY KEY,
      job_id BIGINT REFERENCES provider_feeder_jobs(id) ON DELETE CASCADE,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      finished_at TIMESTAMPTZ,
      raw_count INTEGER NOT NULL DEFAULT 0,
      candidate_count INTEGER NOT NULL DEFAULT 0,
      status VARCHAR(20) NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','failed')),
      error TEXT
    )
  `);

  await query(`CREATE INDEX IF NOT EXISTS idx_feeder_jobs_status_priority ON provider_feeder_jobs (status, priority DESC, created_at)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_feeder_jobs_region_service ON provider_feeder_jobs (country_code, region_name, service_line)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_raw_results_job_id ON google_maps_raw_results (job_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_raw_results_place_id ON google_maps_raw_results (google_place_id)`);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_feeder_candidates_dedupe ON provider_feeder_candidates (dedupe_key)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_feeder_candidates_name ON provider_feeder_candidates (normalized_name)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_feeder_candidates_country ON provider_feeder_candidates (country_code)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_feeder_runs_status ON provider_feeder_runs (status, started_at DESC)`);

  columnCache.clear();
  logger.info("Feeder-owned Neon schema bootstrap completed");
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
