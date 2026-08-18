// Minimal migration runner: applies migrations/*.sql in name order against
// DATABASE_URL. Run it on a branch via `tendb migrate` (which sets the URL):
//   tendb migrate my-branch -- node scripts/migrate.mjs
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set — run through `tendb migrate`");
  process.exit(2);
}

const migrationsDir = join(dirname(dirname(fileURLToPath(import.meta.url))), "migrations");
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
    process.stderr.write(`applying ${file}\n`);
    await client.query(readFileSync(join(migrationsDir, file), "utf8"));
  }
} finally {
  await client.end();
}
