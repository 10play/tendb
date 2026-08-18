import type { Command } from "commander";
import { printJson, printTable, progress } from "../output.js";
import { globalOpts, withSession } from "./shared.js";
import { resolveReplicationUrls } from "../replication-urls.js";
import { snapshotSsm } from "../snapshots.js";
import {
  forceSchemaSync,
  getSchemaConfig,
  schemaDrift,
  setSchemaConfig,
} from "../schema-sync.js";

/**
 * Schema drift tooling for streaming deployments: DDL never replicates, so
 * the sync target drifts silently — diff shows it, sync reconciles it, and
 * the auto-heal config lets the engine host fix additive drift on its own.
 */
export function registerSchema(program: Command): void {
  const schema = program.command("schema").description("schema drift between the source and the sync target");

  schema
    .command("diff")
    .description("compare schemas; exit 1 when drifted")
    .action(async (_opts: unknown, cmd: Command) => {
      const drift = await withSession(cmd, async (session) =>
        schemaDrift(await resolveReplicationUrls(session)),
      );
      const drifted = drift.missing.length + drift.orphaned.length + drift.mismatched.length > 0;
      if (globalOpts(cmd).output === "json") printJson({ ...drift, inSync: !drifted });
      else if (!drifted) printTable(["", ""], [["schema", "in sync"]]);
      else {
        printTable(
          ["", ""],
          [
            ["missing on sync target", drift.missing.join(", ") || "-"],
            ["only on sync target", drift.orphaned.join(", ") || "-"],
            ["columns differ", drift.mismatched.join(", ") || "-"],
          ],
        );
      }
      process.exitCode = drifted ? 1 : 0;
    });

  schema
    .command("sync")
    .description("full reconcile via the engine host (creates missing tables, DROPS orphans)")
    .action(async (_opts: unknown, cmd: Command) => {
      const started = Date.now();
      await withSession(cmd, async (session) =>
        forceSchemaSync(
          snapshotSsm(session.config, session.params),
          session.config.ssmPrefix,
          await resolveReplicationUrls(session),
        ),
      );
      progress(`schema in sync (${((Date.now() - started) / 1000).toFixed(1)}s)`);
    });

  schema
    .command("config")
    .description("show or set auto-heal (daemon fixes additive drift on its own)")
    .option("--auto-sync <on|off>", "enable/disable additive auto-heal")
    .action(async (opts: { autoSync?: string }, cmd: Command) => {
      const result = await withSession(cmd, async (session) => {
        const ssm = snapshotSsm(session.config, session.params);
        const prefix = session.config.ssmPrefix;
        if (opts.autoSync !== undefined) {
          const next = { autoSync: opts.autoSync === "on" };
          await setSchemaConfig(ssm, prefix, next);
          return next;
        }
        return (await getSchemaConfig(ssm, prefix)) ?? { autoSync: false };
      });
      if (globalOpts(cmd).output === "json") printJson(result);
      else printTable(["", ""], [["auto-heal", result.autoSync ? "on" : "off"]]);
    });
}
