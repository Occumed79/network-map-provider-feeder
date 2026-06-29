import { readFileSync } from "fs";
import { join } from "path";
import { query, end } from "../src/db.js";
import { logger } from "../src/logger.js";

async function migrate() {
  const sqlPath = join(process.cwd(), "sql", "001_init.sql");
  const sql = readFileSync(sqlPath, "utf8");

  logger.info("Running migration: 001_init.sql");

  try {
    await query(sql);
    logger.info("Migration completed successfully.");
  } catch (err) {
    logger.error("Migration failed", { error: err.message });
    throw err;
  } finally {
    await end();
  }
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
