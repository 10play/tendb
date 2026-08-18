// End-to-end proof the local platform works: branch → migrate on the branch →
// query it (seed data + migrated column) → delete the branch. Exercises the
// same CLI verbs CI would (`ci url` keeps the URI-last-line contract).
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const exampleDir = dirname(dirname(fileURLToPath(import.meta.url)));
const binary = join(exampleDir, "node_modules", ".bin", "tendb");
const BRANCH = process.env.DEMO_BRANCH ?? "demo";

function tendb(args, opts = {}) {
  return execFileSync(binary, args, { cwd: exampleDir, encoding: "utf8", ...opts });
}

const step = (msg) => process.stderr.write(`\n=== ${msg}\n`);

step(`branch "${BRANCH}" (copy-on-write, ~5s)`);
tendb(["branches", "create", BRANCH], { stdio: "inherit" });

step("rehearse the migration on the branch");
tendb(["migrate", BRANCH, "--", "node", "scripts/migrate.mjs"], { stdio: "inherit" });

step("query the branch");
const url = tendb(["ci", "url", BRANCH, "--quiet"]).trim().split("\n").at(-1);
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const { rows } = await client.query(
    "SELECT count(*)::int AS users, (SELECT count(*)::int FROM orders WHERE status = 'new') AS migrated FROM users",
  );
  console.log(`users: ${rows[0].users}, orders with the migrated column: ${rows[0].migrated}`);
  if (rows[0].users < 1 || rows[0].migrated < 1) {
    throw new Error("expected seeded rows and the migrated status column");
  }
} finally {
  await client.end();
}

step(`delete branch "${BRANCH}"`);
tendb(["branches", "delete", BRANCH], { stdio: "inherit" });

step("done — production never saw any of that");
