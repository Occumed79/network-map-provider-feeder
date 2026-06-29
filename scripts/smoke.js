import { query, end } from "../src/db.js";
import { logger } from "../src/logger.js";

const REQUIRED_TABLES = [
  "provider_feeder_jobs",
  "google_maps_raw_results",
  "provider_candidates",
  "provider_candidate_sources",
  "provider_feeder_runs",
];

async function smoke() {
  let allPassed = true;

  // 1. Database connectivity
  try {
    const { rows } = await query("SELECT now() AS now, version() AS version");
    logger.info("Database connected", {
      timestamp: rows[0].now,
      version: rows[0].version.slice(0, 60),
    });
  } catch (err) {
    logger.error("Database connection FAILED", { error: err.message });
    allPassed = false;
  }

  // 2. Table existence
  for (const table of REQUIRED_TABLES) {
    try {
      const { rows } = await query(
        `SELECT to_regclass('public.${table}') AS exists`
      );
      if (rows[0].exists) {
        logger.info(`Table OK: ${table}`);
      } else {
        logger.error(`Table MISSING: ${table}`);
        allPassed = false;
      }
    } catch (err) {
      logger.error(`Error checking table ${table}`, { error: err.message });
      allPassed = false;
    }
  }

  // 3. Row counts
  if (allPassed) {
    for (const table of REQUIRED_TABLES) {
      try {
        const { rows } = await query(`SELECT count(*) AS cnt FROM ${table}`);
        logger.info(`Row count: ${table} = ${rows[0].cnt}`);
      } catch (err) {
        logger.error(`Count failed for ${table}`, { error: err.message });
      }
    }
  }

  await end();

  if (allPassed) {
    logger.info("Smoke test PASSED ✓");
    process.exit(0);
  } else {
    logger.error("Smoke test FAILED ✗");
    process.exit(1);
  }
}

smoke().catch((err) => {
  console.error(err);
  process.exit(1);
});
