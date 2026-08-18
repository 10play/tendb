import { spawn } from "node:child_process";
import type { Command } from "commander";
import { MissingDependencyError } from "../errors.js";
import { normalizeBranchName } from "../naming.js";
import { progress } from "../output.js";
import { getBranchClone } from "../dblab/workflows.js";
import { localizeUri, withSession } from "./shared.js";

export function registerPsql(program: Command): void {
  program
    .command("psql")
    .description("open psql against a branch database through an SSM tunnel")
    .argument("<name>")
    .argument("[psqlArgs...]", "extra args passed through to psql (after --)")
    .action(async (rawName: string, rawArgs: string[], _opts: unknown, cmd: Command) => {
      const name = normalizeBranchName(rawName);
      // commander keeps the literal "--" in the variadic — drop it.
      const psqlArgs = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;
      const code = await withSession(cmd, async (session) => {
        const { clone, uri } = await getBranchClone(session, name);
        const tunnel = await session.openClonePort(Number(clone.db?.port));
        const localUri = localizeUri(uri, tunnel.localPort);
        progress(`tunnel up (localhost:${tunnel.localPort}) — starting psql`);
        return new Promise<number>((resolvePsql, reject) => {
          // Options must precede the conninfo — psql ignores trailing options.
          const child = spawn("psql", [...psqlArgs, localUri], { stdio: "inherit" });
          child.once("error", (err: NodeJS.ErrnoException) => {
            reject(
              err.code === "ENOENT"
                ? new MissingDependencyError("psql not found on PATH", "install it: brew install libpq (or postgresql)")
                : err,
            );
          });
          child.once("exit", (exitCode) => resolvePsql(exitCode ?? 0));
        });
      });
      process.exitCode = code;
    });
}
