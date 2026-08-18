import { createRequire } from "node:module";
import { Command } from "commander";
import pc from "picocolors";
import { TenDBError } from "./errors.js";
import { registerBranches } from "./commands/branches.js";
import { registerCheckup } from "./commands/checkup.js";
import { registerDown } from "./commands/down.js";
import { registerInit } from "./commands/init.js";
import { registerUp } from "./commands/up.js";
import { registerCi } from "./commands/ci.js";
import { registerConnectionString } from "./commands/connection-string.js";
import { registerMigrate } from "./commands/migrate.js";
import { registerConsole } from "./commands/console.js";
import { registerPsql } from "./commands/psql.js";
import { registerSchema } from "./commands/schema.js";
import { registerSnapshots } from "./commands/snapshots.js";
import { registerStatus } from "./commands/status.js";
import { registerTunnel } from "./commands/tunnel.js";
import { registerUi } from "./commands/ui.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

const program = new Command()
  .name("tendb")
  .description("Neon-style Postgres branching on DBLab, over AWS SSM")
  .version(version)
  .enablePositionalOptions();

registerInit(program);
registerUp(program);
registerDown(program);
registerBranches(program);
registerConnectionString(program);
registerStatus(program);
registerPsql(program);
registerTunnel(program);
registerUi(program);
registerConsole(program);
registerCi(program);
registerMigrate(program);
registerCheckup(program);
registerSnapshots(program);
registerSchema(program);

/**
 * Commander only honors parent options placed before the subcommand, so the
 * shared option set is applied to every leaf command (and optsWithGlobals()
 * merges them back together).
 */
function applyGlobalOptions(cmd: Command): void {
  if (cmd.commands.length > 0) {
    for (const sub of cmd.commands) applyGlobalOptions(sub);
    return;
  }
  cmd
    .option("--env <name>", "environment block from tendb.json")
    .option("--platform <name>", "aws|gcp|azure|local (default aws)")
    .option("--region <region>", "AWS region")
    .option("--profile <profile>", "AWS profile")
    .option("--ssm-prefix <prefix>", "SSM parameter prefix (default /tendb)")
    .option("--instance-id <id>", "DBLab host instance id (skips SSM discovery)")
    .option("--api-url <url>", "direct DBLab API URL (no AWS/SSM; needs token config)")
    .option("--config <path>", "path to tendb.json")
    .option("-o, --output <format>", "table|json", "table")
    .option("--quiet", "suppress progress output");
}
applyGlobalOptions(program);

program.parseAsync(process.argv).catch((err: unknown) => {
  if (err instanceof TenDBError) {
    process.stderr.write(pc.red(`error: ${err.message}`) + "\n");
    if (err.hint) process.stderr.write(pc.dim(`hint: ${err.hint}`) + "\n");
    process.exit(err.exitCode);
  }
  process.stderr.write(pc.red(`unexpected error: ${(err as Error)?.stack ?? String(err)}`) + "\n");
  process.exit(1);
});
