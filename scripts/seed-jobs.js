import { end } from "../src/db.js";
import { seedTargetedJobs } from "../src/jobSeeder.js";

const maxJobs = Number.parseInt(process.env.MAX_SEED_JOBS || "250", 10);

async function main() {
  try {
    await seedTargetedJobs({ maxJobs, source: "manual_seed" });
  } finally {
    await end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
