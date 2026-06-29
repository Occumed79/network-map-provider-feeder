import { query, end } from "../src/db.js";
import { logger } from "../src/logger.js";

const SEED_JOBS = [
  {
    query: "occupational health clinic in Los Angeles CA",
    country_code: "US",
    region_name: "California",
    service_line: "occupational_health",
  },
  {
    query: "occupational medicine clinic in Houston TX",
    country_code: "US",
    region_name: "Texas",
    service_line: "occupational_medicine",
  },
  {
    query: "workers compensation clinic in Chicago IL",
    country_code: "US",
    region_name: "Illinois",
    service_line: "workers_comp",
  },
  {
    query: "DOT physical clinic in Atlanta GA",
    country_code: "US",
    region_name: "Georgia",
    service_line: "dot_physical",
  },
  {
    query: "pre employment physical clinic in Phoenix AZ",
    country_code: "US",
    region_name: "Arizona",
    service_line: "pre_employment",
  },
];

async function seed() {
  logger.info(`Seeding ${SEED_JOBS.length} test jobs...`);

  let inserted = 0;
  for (const job of SEED_JOBS) {
    try {
      await query(
        `INSERT INTO provider_feeder_jobs (query, country_code, region_name, service_line)
         VALUES ($1, $2, $3, $4)`,
        [job.query, job.country_code, job.region_name, job.service_line]
      );
      inserted++;
      logger.info("Seeded job", { query: job.query });
    } catch (err) {
      logger.error("Failed to seed job", { query: job.query, error: err.message });
    }
  }

  logger.info(`Seeding complete. ${inserted}/${SEED_JOBS.length} jobs inserted.`);
  await end();
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
