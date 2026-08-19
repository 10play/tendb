import { randomBytes } from "node:crypto";
import type { ParamStore } from "./platform/types.js";
import { TimeoutError, UsageError } from "./errors.js";
import {
  diffSchemas,
  fetchReplicationStatus,
  type SchemaDiff,
} from "./console/replication.js";

/**
 * Schema reconciliation for streaming deployments. DDL never replicates, so
 * the sync target drifts silently; the engine host's daemon can heal it —
 * additively on its own (auto-sync), fully on demand (force sync, which also
 * drops orphaned tables). Driven by two SSM parameters:
 *   <prefix>/schema/config        {"autoSync": true}
 *   <prefix>/schema/sync-request  nonce — a new value means "full sync now"
 */

export interface SchemaSyncConfig {
  /** Daemon heals additive drift (missing tables) on its own every ~minute. */
  autoSync: boolean;
}

export function validateSchemaConfig(value: unknown): SchemaSyncConfig {
  const cfg = value as Partial<SchemaSyncConfig> | null;
  if (typeof cfg?.autoSync !== "boolean") {
    throw new UsageError("schema config must be {autoSync: boolean}");
  }
  return { autoSync: cfg.autoSync };
}

export async function getSchemaConfig(
  params: ParamStore,
  ssmPrefix: string,
): Promise<SchemaSyncConfig | null> {
  const raw = await params.getParameter(`${ssmPrefix}/schema/config`);
  if (!raw) return null;
  try {
    return validateSchemaConfig(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function setSchemaConfig(
  params: ParamStore,
  ssmPrefix: string,
  config: SchemaSyncConfig,
): Promise<void> {
  await params.putParameter(`${ssmPrefix}/schema/config`, JSON.stringify(validateSchemaConfig(config)));
}

/** Current drift between publisher and subscriber (empty lists = in sync). */
export async function schemaDrift(urls: {
  publisher: string | null;
  subscriber: string | null;
}): Promise<SchemaDiff> {
  const status = await fetchReplicationStatus(
    urls.publisher ?? undefined,
    urls.subscriber ?? undefined,
    { includeSchema: true },
  );
  if (!status.publisher?.tables || !status.subscriber?.tables) {
    throw new UsageError(
      "cannot compare schemas",
      status.publisher?.error ?? status.subscriber?.error ?? "one side did not answer",
    );
  }
  return diffSchemas(status.publisher.tables, status.subscriber.tables);
}

/** Fire a full-sync request without waiting (async callers poll schemaDrift). */
export async function requestSchemaSync(params: ParamStore, ssmPrefix: string): Promise<string> {
  const nonce = `sync-${Date.now()}-${randomBytes(4).toString("hex")}`;
  await params.putParameter(`${ssmPrefix}/schema/sync-request`, nonce);
  return nonce;
}

/** Daemon's answer to a sync-request nonce (schema/sync-result param). */
export interface SchemaSyncResult {
  nonce: string;
  ok: boolean;
  error?: string;
}

async function readSyncResult(params: ParamStore, ssmPrefix: string): Promise<SchemaSyncResult | null> {
  const raw = await params.getParameter(`${ssmPrefix}/schema/sync-result`);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<SchemaSyncResult>;
    return typeof value?.nonce === "string" && typeof value?.ok === "boolean"
      ? (value as SchemaSyncResult)
      : null;
  } catch {
    return null;
  }
}

function describeDrift(drift: SchemaDiff): string {
  const parts: string[] = [];
  if (drift.missing.length > 0) parts.push(`missing on sync target: ${drift.missing.join(", ")}`);
  if (drift.orphaned.length > 0) parts.push(`only on sync target: ${drift.orphaned.join(", ")}`);
  if (drift.mismatched.length > 0) parts.push(`columns differ: ${drift.mismatched.join(", ")}`);
  return parts.join(" · ");
}

/**
 * Force a full reconcile (missing tables created, orphans dropped,
 * publication refreshed) and wait until the drift reads clean. The daemon
 * answers the request nonce via schema/sync-result, so a failed sync (e.g.
 * snapshotd cannot reach a database) surfaces its reason within a poll or
 * two instead of hanging to the timeout; drift the daemon cannot heal
 * (column mismatches need DDL) fails fast with what remains.
 */
export async function forceSchemaSync(
  params: ParamStore,
  ssmPrefix: string,
  urls: { publisher: string | null; subscriber: string | null },
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<SchemaDiff> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const pollMs = opts.pollMs ?? 3_000;
  const nonce = await requestSchemaSync(params, ssmPrefix);

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await new Promise((r) => setTimeout(r, pollMs));
    const result = await readSyncResult(params, ssmPrefix);
    const answered = result?.nonce === nonce; // stale answers belong to older requests
    if (answered && !result.ok) {
      throw new UsageError("schema sync failed on the engine host", result.error ?? "no detail");
    }
    const drift = await schemaDrift(urls).catch(() => null);
    if (drift && drift.missing.length === 0 && drift.orphaned.length === 0 && drift.mismatched.length === 0) {
      return drift;
    }
    if (answered && drift) {
      throw new UsageError(
        "schema sync ran but drift remains (column drift needs manual DDL on the sync target)",
        describeDrift(drift),
      );
    }
    if (Date.now() > deadline) {
      throw new TimeoutError(
        `schema still drifted after ${Math.round(timeoutMs / 1000)}s`,
        "check tendb-snapshotd logs on the engine host (journalctl -u tendb-snapshotd)",
      );
    }
  }
}
