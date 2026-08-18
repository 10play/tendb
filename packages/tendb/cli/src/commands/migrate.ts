import type { Command } from "commander";
import { UsageError } from "../errors.js";
import { printJson, progress } from "../output.js";
import { migrate } from "../migrate.js";
import { createSnapshotNow, snapshotSsm } from "../snapshots.js";
import { normalizeBranchName } from "../naming.js";
import { globalOpts, withSession } from "./shared.js";

/**
 * The migration face of the CI contract: run a command with DATABASE_URL
 * pointed at a branch, exit with the command's code.
 *
 *   tendb migrate my-branch -- npx prisma migrate deploy
 *   tendb migrate --scratch -- npx prisma migrate deploy   # rehearse + clean up
 */
export function registerMigrate(program: Command): void {
  program
    .command("migrate")
    .description("run a migration command against a branch (DATABASE_URL set); --scratch rehearses on an ephemeral branch")
    .argument("[branch]", "target branch; omit with --scratch")
    .argument("[execCmd...]", "command to run (after --)")
    .option("--scratch", "create an ephemeral branch, run, then delete it")
    .option("--from <branch>", "base branch for --scratch", "main")
    .option("--keep", "keep the scratch branch after the run")
    .option("--fresh", "snapshot the streaming sync target first (rehearse on data as-of-now)")
    .action(
      async (
        rawName: string | undefined,
        rawCmd: string[],
        opts: { scratch?: boolean; from: string; keep?: boolean; fresh?: boolean },
        cmd: Command,
      ) => {
        // commander keeps the literal "--" in the variadic — drop it. With
        // --scratch there is no branch positional, so rawName is actually the
        // command's first word.
        let command = rawCmd[0] === "--" ? rawCmd.slice(1) : rawCmd;
        let branch: string | undefined;
        if (opts.scratch) {
          if (rawName) command = [rawName, ...command];
        } else {
          if (!rawName) throw new UsageError("name a branch, or pass --scratch for an ephemeral one");
          branch = normalizeBranchName(rawName);
        }
        if (command.length === 0) throw new UsageError("no command given — pass it after `--`");

        const result = await withSession(cmd, async (session) => {
          if (opts.fresh) {
            await createSnapshotNow(session.client, snapshotSsm(session.config, session.params), session.config.ssmPrefix);
          }
          return migrate(session, { command, branch, from: opts.from, keep: opts.keep });
        });

        if (globalOpts(cmd).output === "json") printJson(result);
        else {
          progress(
            `${result.ok ? "ok" : `failed (exit ${result.exitCode})`} on ${result.branch} in ${result.durationMs}ms` +
              (result.kept ? "" : " — scratch branch removed"),
          );
        }
        process.exitCode = result.exitCode;
      },
    );
}
