import { spawn } from "node:child_process";
import type { ApiSession } from "./context.js";
import { UsageError } from "./errors.js";
import { getBranchClone, ensureBranch, deleteBranch } from "./dblab/workflows.js";
import { localizeUri } from "./commands/shared.js";
import { progress } from "./output.js";

/**
 * Run a command against a branch database with DATABASE_URL set — the
 * migration primitive. Over SSM a port-forward is opened for the call; on
 * direct transport (in-VPC, tests) the clone URI is dialed as-is.
 */
export interface ExecResult {
  exitCode: number;
  durationMs: number;
}

export interface BranchUrl {
  /** Dial-ready URL (tunnel-localized over SSM). */
  url: string;
  /** The clone's canonical URI on the engine host. */
  remote: string;
  close(): Promise<void>;
}

export async function openBranchUrl(session: ApiSession, branch: string): Promise<BranchUrl> {
  const { clone, uri } = await getBranchClone(session, branch);
  if (!session.canTunnel) {
    return { url: uri, remote: uri, close: async () => {} };
  }
  const tunnel = await session.openClonePort(Number(clone.db?.port));
  return {
    url: localizeUri(uri, tunnel.localPort),
    remote: uri,
    close: () => tunnel.close(),
  };
}

export async function execOnBranch(
  session: ApiSession,
  branch: string,
  argv: string[],
  opts: { env?: Record<string, string> } = {},
): Promise<ExecResult> {
  if (argv.length === 0) throw new UsageError("no command given");
  const opened = await openBranchUrl(session, branch);
  const started = Date.now();
  try {
    const exitCode = await new Promise<number>((resolveChild, reject) => {
      const [bin, ...args] = argv as [string, ...string[]];
      const child = spawn(bin, args, {
        stdio: "inherit",
        env: { ...process.env, ...opts.env, DATABASE_URL: opened.url },
      });
      child.once("error", reject);
      child.once("exit", (code) => resolveChild(code ?? 0));
    });
    return { exitCode, durationMs: Date.now() - started };
  } finally {
    await opened.close().catch(() => {});
  }
}

export interface MigrateOptions {
  command: string[];
  /** Target branch; omitted = scratch branch created and (by default) deleted. */
  branch?: string;
  from?: string;
  /** Keep the scratch branch after the run (inspect the result). */
  keep?: boolean;
  /** Snapshot the streaming sync target first — rehearse on data as-of-now. */
  fresh?: boolean;
  env?: Record<string, string>;
}

export interface MigrateResult {
  ok: boolean;
  exitCode: number;
  durationMs: number;
  branch: string;
  /** True when the branch outlives the call (named target or keep:true). */
  kept: boolean;
}

/**
 * Rehearse a migration against production-shaped data: ensure the branch
 * (scratch one when unnamed), run the command with DATABASE_URL, and clean up
 * the scratch branch unless asked to keep it. A failing command keeps its exit
 * code; a failing scratch run is deleted anyway so reruns start pristine.
 */
export async function migrate(session: ApiSession, opts: MigrateOptions): Promise<MigrateResult> {
  const scratch = !opts.branch;
  const branch = opts.branch ?? `migrate-${Date.now().toString(36)}`;
  await ensureBranch(session, branch, { from: opts.from });
  try {
    const { exitCode, durationMs } = await execOnBranch(session, branch, opts.command, {
      env: opts.env,
    });
    return {
      ok: exitCode === 0,
      exitCode,
      durationMs,
      branch,
      kept: !scratch || Boolean(opts.keep),
    };
  } finally {
    if (scratch && !opts.keep) {
      progress(`cleaning up scratch branch ${branch}`);
      await deleteBranch(session, branch).catch(() => {});
    }
  }
}
