import { spawn } from "node:child_process";
import { MissingDependencyError } from "../errors.js";
import { getFreePort, waitForTcp } from "../util/ports.js";
import type { Tunnel } from "./types.js";

/**
 * Generic child-process tunnel lifecycle, shared by the gcloud and az
 * adapters. Mirrors the battle-tested session-manager-plugin handling in
 * aws/session.ts: spawn, race TCP readiness against spawn errors and early
 * death, close via SIGTERM. ENOENT becomes a MissingDependencyError with an
 * install hint.
 */
export async function spawnTunnelProcess(opts: {
  command: string;
  /** argv builder — called with the resolved local port. */
  args: (localPort: number) => string[];
  localPort?: number;
  remotePort: number;
  readyTimeoutMs?: number;
  missingHint: string;
}): Promise<Tunnel> {
  const localPort = opts.localPort ?? (await getFreePort());
  const child = spawn(opts.command, opts.args(localPort), { stdio: ["ignore", "ignore", "ignore"] });

  let exited = false;
  const onExit = new Promise<void>((resolve) => {
    child.once("exit", () => {
      exited = true;
      resolve();
    });
  });

  const spawnError = new Promise<never>((_, reject) => {
    child.once("error", (err: NodeJS.ErrnoException) => {
      reject(
        err.code === "ENOENT"
          ? new MissingDependencyError(`${opts.command} not found on PATH`, opts.missingHint)
          : err,
      );
    });
  });

  const close = async () => {
    if (!exited) {
      child.kill("SIGTERM");
      await onExit;
    }
  };

  const deadTunnel = onExit.then(() => {
    throw new Error(`${opts.command} exited before the tunnel became ready`);
  });

  try {
    await Promise.race([waitForTcp(localPort, opts.readyTimeoutMs ?? 30_000), spawnError, deadTunnel]);
  } catch (err) {
    await close();
    throw err;
  }

  return { localPort, remotePort: opts.remotePort, close, onExit };
}
