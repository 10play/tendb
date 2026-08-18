// Regenerates tendb/ (and tendb.json) with the scaffolder itself, so the
// committed example can never drift from what `tendb init` emits. The
// scaffold-validate test suite diffs a fresh render against the committed
// files. Module sources stay relative (this dir lives inside the repo);
// external users get git-pinned sources instead.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const exampleDir = dirname(dirname(fileURLToPath(import.meta.url)));
const cliDir = join(exampleDir, "..", "..", "packages", "tendb", "cli");
const binary = join(cliDir, "dist", "index.js");

if (!existsSync(binary)) {
  execFileSync("pnpm", ["build:cli"], { cwd: cliDir, stdio: "inherit" });
}

const res = spawnSync(
  process.execPath,
  [
    binary, "init",
    "--platform", "local", "--yes", "--force",
    "--dir", "tendb",
    "--modules-source", "../../../packages/tendb/terraform/modules",
  ],
  { cwd: exampleDir, stdio: "inherit" },
);
process.exit(res.status ?? 1);
