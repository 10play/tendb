import { spawn } from "node:child_process";
import type { Command } from "commander";
import { API_PORT } from "../context.js";
import { normalizeBranchName } from "../naming.js";
import { progress } from "../output.js";
import { getBranchClone } from "../dblab/workflows.js";
import { localizeUri, withSession } from "./shared.js";

function waitForever(): Promise<never> {
  return new Promise(() => {});
}

export function registerTunnel(program: Command): void {
  program
    .command("tunnel")
    .description(
      "forward a branch database's Postgres port (or the DBLab API with no name); " +
        "with `-- cmd`, run cmd with DATABASE_URL set and exit with its code",
    )
    .argument("[name]", "branch name; omit to forward the DBLab API port")
    .argument("[execCmd...]", "command to run with DATABASE_URL exported (after --)")
    .option("--port <port>", "local port (default: same as the remote port)")
    .action(async (rawName: string | undefined, rawCmd: string[], opts: { port?: string }, cmd: Command) => {
      // commander keeps the literal "--" in the variadic — drop it.
      const execCmd = rawCmd[0] === "--" ? rawCmd.slice(1) : rawCmd;
      const code = await withSession(cmd, async (session) => {
        let remotePort: number;
        let uri: string | undefined;
        if (rawName) {
          const name = normalizeBranchName(rawName);
          const found = await getBranchClone(session, name);
          remotePort = Number(found.clone.db?.port);
          uri = found.uri;
        } else {
          remotePort = API_PORT;
        }
        const localPort = opts.port ? Number(opts.port) : remotePort;
        const tunnel = await session.openClonePort(remotePort, localPort);
        const localUri = uri ? localizeUri(uri, tunnel.localPort) : undefined;

        if (execCmd.length === 0) {
          progress(`forwarding localhost:${tunnel.localPort} → ${remotePort} (ctrl-c to stop)`);
          if (localUri) progress(`DATABASE_URL=${localUri}`);
          const stop = new Promise<number>((r) => {
            process.once("SIGINT", () => r(0));
            process.once("SIGTERM", () => r(0));
          });
          // If the plugin dies (session limits), respawn is the caller's job —
          // in foreground mode, exit so scripts notice.
          return Promise.race([stop, tunnel.onExit.then(() => 1), waitForever()]);
        }

        progress(`tunnel up — running: ${execCmd.join(" ")}`);
        return new Promise<number>((resolveChild, reject) => {
          const [bin, ...args] = execCmd as [string, ...string[]];
          const child = spawn(bin, args, {
            stdio: "inherit",
            env: { ...process.env, ...(localUri ? { DATABASE_URL: localUri } : {}) },
          });
          child.once("error", reject);
          child.once("exit", (exitCode) => resolveChild(exitCode ?? 0));
        });
      });
      process.exitCode = code;
    });
}
