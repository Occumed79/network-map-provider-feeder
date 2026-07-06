import { readFile } from "fs/promises";
import { join } from "path";
import { query } from "./db.js";
import { logger } from "./logger.js";

export async function migrateSchema() {
  const sqlPath = join(process.cwd(), "sql", "001_init.sql");
  const sql = await readFile(sqlPath, "utf8");
  logger.info("Running migration: 001_init.sql");
  await query(sql);
  logger.info("Migration completed successfully.");
}
