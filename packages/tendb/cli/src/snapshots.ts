import { randomBytes } from "node:crypto";
import type { DblabClient } from "./dblab/client.js";
import type { Snapshot } from "./dblab/types.js";
import type { ParamStore } from "./platform/types.js";
import { createParamStore } from "./platform/index.js";
import { TenDBError, TimeoutError, UsageError } from "./errors.js";
import type { ResolvedConfig } from "./config.js";
import { progress } from "./output.js";

/**
 * Programmable pool snapshots for streaming deployments. The engine host runs
 * a small executor (`tendb-snapshotd`) that CHECKPOINTs the sync target and
 * takes an O(1) `zfs snapshot` — size-independent, ~seconds at 200 GB or 1 TB.
 * Clients drive it through two SSM parameters:
 *   <prefix>/snapshots/config   {"intervalMinutes":60,"retain":24} (0 = manual)
 *   <prefix>/snapshots/request  nonce — a new value means "snapshot now"
 */

export interface SnapshotScheduleConfig {
  /** 0 disables the schedule (on-demand only). */
  intervalMinutes: number;
  /** Pool snapshots kept; older ones are pruned unless branches depend on them. */
  retain: number;
}

/** Pool-level snapshots (branch heads like `.../branch/x@ts` are excluded). */
export function poolSnapshots(snapshots: Snapshot[]): Snapshot[] {
  return snapshots.filter((s) => /@snapshot_/.test(s.id));
}

/**
 * A ParamStore for config/request access, working on any transport: the
 * session's own store when present, else a standalone one built from config
 * (how the hosted console reaches the store on direct transport).
 */
export function controlParams(cfg: ResolvedConfig, sessionParams?: ParamStore): ParamStore {
  if (sessionParams) return sessionParams;
  return createParamStore(cfg);
}

/** @deprecated renamed to controlParams (works on every platform, not just SSM). */
export const snapshotSsm = controlParams;

export function validateScheduleConfig(value: unknown): SnapshotScheduleConfig {
  const cfg = value as Partial<SnapshotScheduleConfig> | null;
  const intervalMinutes = Number(cfg?.intervalMinutes);
  const retain = Number(cfg?.retain);
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 0 || intervalMinutes > 10_080) {
    throw new UsageError("intervalMinutes must be an integer between 0 (manual) and 10080");
  }
  if (!Number.isInteger(retain) || retain < 1 || retain > 500) {
    throw new UsageError("retain must be an integer between 1 and 500");
  }
  return { intervalMinutes, retain };
}

export async function getScheduleConfig(
  params: ParamStore,
  ssmPrefix: string,
): Promise<SnapshotScheduleConfig | null> {
  const raw = await params.getParameter(`${ssmPrefix}/snapshots/config`);
  if (!raw) return null;
  try {
    return validateScheduleConfig(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function setScheduleConfig(
  params: ParamStore,
  ssmPrefix: string,
  config: SnapshotScheduleConfig,
): Promise<void> {
  await params.putParameter(`${ssmPrefix}/snapshots/config`, JSON.stringify(validateScheduleConfig(config)));
}

/** Fire a snapshot request without waiting (async callers poll the listing). */
export async function requestSnapshot(params: ParamStore, ssmPrefix: string): Promise<string> {
  const nonce = `req-${Date.now()}-${randomBytes(4).toString("hex")}`;
  await params.putParameter(`${ssmPrefix}/snapshots/request`, nonce);
  return nonce;
}

/**
 * Snapshot-now: write a request nonce and wait for the executor to produce a
 * new pool snapshot. Typical wall time ~10 s (5 s poll tick + zfs + a ~2 s
 * engine rescan restart).
 */
export async function createSnapshotNow(
  client: DblabClient,
  params: ParamStore,
  ssmPrefix: string,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<Snapshot> {
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const pollMs = opts.pollMs ?? 2_000;

  const before = new Set(poolSnapshots(await client.listSnapshots()).map((s) => s.id));
  await requestSnapshot(params, ssmPrefix);
  progress("snapshot requested — waiting for the engine host…");

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await new Promise((r) => setTimeout(r, pollMs));
    // The engine restarts briefly while rescanning — tolerate blips.
    const listed = await client.listSnapshots().catch(() => null);
    if (listed) {
      const fresh = poolSnapshots(listed).find((s) => !before.has(s.id));
      if (fresh) return fresh;
    }
    if (Date.now() > deadline) {
      throw new TimeoutError(
        `no new snapshot after ${Math.round(timeoutMs / 1000)}s`,
        "is tendb-snapshotd running on the engine host? `systemctl status tendb-snapshotd`",
      );
    }
  }
}

/** Guard for flows that need a snapshot capability before proceeding. */
export function assertSnapshotSupport(cfg: ResolvedConfig, sessionParams?: ParamStore): ParamStore {
  try {
    return controlParams(cfg, sessionParams);
  } catch (err) {
    throw err instanceof TenDBError
      ? err
      : new UsageError("snapshot control unavailable", String(err));
  }
}
