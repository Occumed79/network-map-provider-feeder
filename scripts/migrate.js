import { end } from "../src/db.js";
import { migrateSchema } from "../src/schema.js";

async function migrate() {
  try {
    await migrateSchema();
  } finally {
    await end();
  }
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
