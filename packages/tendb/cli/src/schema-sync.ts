import { randomBytes } from "node:crypto";
import type { SsmFacade } from "./aws/params.js";
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
  ssm: SsmFacade,
  ssmPrefix: string,
): Promise<SchemaSyncConfig | null> {
  const raw = await ssm.getParameter(`${ssmPrefix}/schema/config`);
  if (!raw) return null;
  try {
    return validateSchemaConfig(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function setSchemaConfig(
  ssm: SsmFacade,
  ssmPrefix: string,
  config: SchemaSyncConfig,
): Promise<void> {
  await ssm.putParameter(`${ssmPrefix}/schema/config`, JSON.stringify(validateSchemaConfig(config)));
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
export async function requestSchemaSync(ssm: SsmFacade, ssmPrefix: string): Promise<string> {
  const nonce = `sync-${Date.now()}-${randomBytes(4).toString("hex")}`;
  await ssm.putParameter(`${ssmPrefix}/schema/sync-request`, nonce);
  return nonce;
}

/**
 * Force a full reconcile (missing tables created, orphans dropped, mismatched
 * tables rebuilt, publication refreshed, error counters reset) and wait until
 * the drift reads clean.
 */
export async function forceSchemaSync(
  ssm: SsmFacade,
  ssmPrefix: string,
  urls: { publisher: string | null; subscriber: string | null },
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<SchemaDiff> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const pollMs = opts.pollMs ?? 3_000;
  await requestSchemaSync(ssm, ssmPrefix);

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await new Promise((r) => setTimeout(r, pollMs));
    const drift = await schemaDrift(urls).catch(() => null);
    if (drift && drift.missing.length === 0 && drift.orphaned.length === 0 && drift.mismatched.length === 0) {
      return drift;
    }
    if (Date.now() > deadline) {
      throw new TimeoutError(
        `schema still drifted after ${Math.round(timeoutMs / 1000)}s`,
        "check tendb-snapshotd logs on the engine host (journalctl -u tendb-snapshotd)",
      );
    }
  }
}
