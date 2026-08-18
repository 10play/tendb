import type { Command } from "commander";
import { printJson, printTable, progress } from "../output.js";
import { globalOpts, withSession } from "./shared.js";
import { clonePortCapacity } from "../context.js";

function gb(bytes: number | undefined): string {
  return bytes === undefined ? "-" : `${(bytes / 1024 ** 3).toFixed(1)}G`;
}

export function registerStatus(program: Command): void {
  program
    .command("status")
    .description("engine health, sync state, and clone capacity")
    .action(async (_opts: unknown, cmd: Command) => {
      await withSession(cmd, async (session) => {
        const [healthy, status, capacity] = await Promise.all([
          session.client.healthz(),
          session.client.status(),
          clonePortCapacity(session),
        ]);
        const clones = status.cloning?.clones ?? [];
        const pool = status.pools?.[0];

        if (globalOpts(cmd).output === "json") {
          printJson({
            healthy,
            transport: session.transport,
            instanceId: session.instanceId,
            engineVersion: status.engine?.version,
            retrieving: status.retrieving,
            pools: status.pools,
            clonesUsed: clones.length,
            cloneCapacity: capacity ?? null,
          });
          return;
        }

        const rows: string[][] = [
          ["health", healthy ? "ok" : "UNREACHABLE"],
          ["engine", status.engine?.version ?? "-"],
          ["transport", session.transport + (session.instanceId ? ` (${session.instanceId})` : "")],
          ["sync mode", status.retrieving?.mode ?? "-"],
          ["sync status", status.retrieving?.status ?? "-"],
          ["last refresh", status.retrieving?.lastRefresh ?? "-"],
          ["next refresh", status.retrieving?.nextRefresh ?? "-"],
          ["data state at", pool?.dataStateAt ?? "-"],
          [
            "disk",
            pool?.fileSystem
              ? `${gb(pool.fileSystem.used)} used / ${gb(pool.fileSystem.size)} (${gb(pool.fileSystem.free)} free)`
              : "-",
          ],
          ["clones", `${clones.length}${capacity ? ` / ${capacity}` : ""}`],
        ];
        printTable(["", ""], rows);
        if (clones.length > 0) {
          progress(`running: ${clones.map((c) => c.id).join(", ")}`);
        }
      });
    });
}
