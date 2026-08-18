import type { Command } from "commander";
import { printJson, printTable } from "../output.js";
import { globalOpts, withSession } from "./shared.js";
import { runCheckup } from "../monitor/checkup.js";

/**
 * Cron-able health probe. Exit 0 = clean, 1 = critical findings; --strict
 * makes warnings non-zero too (for pipelines that treat drift as failure).
 */
export function registerCheckup(program: Command): void {
  program
    .command("checkup")
    .description("evaluate platform health: engine, sync, disk, capacity, replication")
    .option("--strict", "exit non-zero on warnings as well as criticals")
    .action(async (opts: { strict?: boolean }, cmd: Command) => {
      const checkup = await withSession(cmd, (session) => runCheckup(session));

      if (globalOpts(cmd).output === "json") {
        printJson(checkup);
      } else if (checkup.findings.length === 0) {
        printTable(["", ""], [["health", "ok — no findings"]]);
      } else {
        printTable(
          ["severity", "code", "message"],
          checkup.findings.map((f) => [f.severity, f.code, f.message]),
        );
      }

      const critical = checkup.findings.some((f) => f.severity === "critical");
      process.exitCode = critical || (opts.strict && checkup.findings.length > 0) ? 1 : 0;
    });
}
