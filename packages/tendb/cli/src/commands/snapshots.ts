import type { Command } from "commander";
import { printJson, printTable, progress } from "../output.js";
import { globalOpts, withSession } from "./shared.js";
import {
  createSnapshotNow,
  getScheduleConfig,
  poolSnapshots,
  setScheduleConfig,
  snapshotSsm,
} from "../snapshots.js";

/**
 * Pool snapshots for streaming deployments: list them, take one on demand
 * (O(1) zfs snapshot — seconds at any database size), and read/write the
 * schedule the on-host executor follows.
 */
export function registerSnapshots(program: Command): void {
  const snapshots = program.command("snapshots").description("pool snapshots (streaming deployments)");

  snapshots
    .command("list")
    .description("list pool snapshots (newest first)")
    .action(async (_opts: unknown, cmd: Command) => {
      const rows = await withSession(cmd, async (session) =>
        poolSnapshots(await session.client.listSnapshots()),
      );
      if (globalOpts(cmd).output === "json") return printJson(rows);
      printTable(
        ["ID", "DATA STATE AT"],
        rows.map((s) => [s.id, s.dataStateAt ?? "-"]),
      );
    });

  snapshots
    .command("create")
    .description("snapshot the streaming sync target now (branchable in ~10s)")
    .action(async (_opts: unknown, cmd: Command) => {
      const started = Date.now();
      const snapshot = await withSession(cmd, async (session) =>
        createSnapshotNow(session.client, snapshotSsm(session.config, session.params), session.config.ssmPrefix),
      );
      if (globalOpts(cmd).output === "json") {
        printJson({ ...snapshot, durationMs: Date.now() - started });
      } else {
        progress(`snapshot ${snapshot.id} ready in ${((Date.now() - started) / 1000).toFixed(1)}s`);
        process.stdout.write(`${snapshot.id}\n`);
      }
    });

  snapshots
    .command("config")
    .description("show or update the snapshot schedule (executor reads it within seconds)")
    .option("--interval-minutes <n>", "minutes between scheduled snapshots (0 = manual only)")
    .option("--retain <n>", "pool snapshots to keep (in-use ones are never pruned)")
    .action(async (opts: { intervalMinutes?: string; retain?: string }, cmd: Command) => {
      const result = await withSession(cmd, async (session) => {
        const ssm = snapshotSsm(session.config, session.params);
        const prefix = session.config.ssmPrefix;
        const current = (await getScheduleConfig(ssm, prefix)) ?? { intervalMinutes: 0, retain: 24 };
        if (opts.intervalMinutes === undefined && opts.retain === undefined) return current;
        const next = {
          intervalMinutes:
            opts.intervalMinutes === undefined ? current.intervalMinutes : Number(opts.intervalMinutes),
          retain: opts.retain === undefined ? current.retain : Number(opts.retain),
        };
        await setScheduleConfig(ssm, prefix, next);
        return next;
      });
      if (globalOpts(cmd).output === "json") return printJson(result);
      printTable(
        ["", ""],
        [
          ["interval", result.intervalMinutes === 0 ? "manual only" : `${result.intervalMinutes}m`],
          ["retain", String(result.retain)],
        ],
      );
    });
}
