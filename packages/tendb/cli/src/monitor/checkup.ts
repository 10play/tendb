import type { InstanceStatus } from "../dblab/types.js";
import type { ApiSession } from "../context.js";
import { clonePortCapacity } from "../context.js";
import { diffSchemas, fetchReplicationStatus, type ReplicationStatus } from "../console/replication.js";
import { resolveReplicationUrls, type ReplicationUrls } from "../replication-urls.js";

/**
 * Platform health as a list of typed findings — the contract alert sinks
 * consume. Rules are pure (`evaluateCheckup`) so thresholds and behaviors are
 * unit-testable; `runCheckup` is the impure gatherer the SDK, the CLI verb and
 * the console route all share.
 */

export type FindingSeverity = "warning" | "critical";

export type FindingCode =
  | "engine-unreachable"
  | "sync-alerts"
  | "data-stale"
  | "disk-usage"
  | "clone-capacity"
  | "replication-publisher"
  | "replication-subscriber"
  | "subscription-disabled"
  | "replication-errors"
  | "slot-inactive"
  | "replication-lag"
  | "replication-stale"
  | "wal-retained"
  | "slot-invalidated"
  | "schema-drift";

export interface Finding {
  code: FindingCode;
  severity: FindingSeverity;
  message: string;
  /** The observed value behind the finding, when numeric/meaningful. */
  value?: number | string;
  threshold?: number | string;
}

export interface CheckupThresholds {
  /** Pool data-state age beyond which branches are considered stale (hours). */
  dataStaleHours: number;
  diskWarnRatio: number;
  diskCriticalRatio: number;
  /** Clones-used ratio that warns before the pool is exhausted. */
  capacityWarnRatio: number;
  /** Publisher WAL bytes the subscriber may fall behind before warning. */
  replicationLagBytes: number;
  /** Seconds since the subscriber last heard from the publisher. */
  replicationStaleSeconds: number;
  /** WAL a slot may pin on the publisher's disk before warning. */
  walRetainedWarnBytes: number;
  /** …and before it is treated as a threat to the publisher itself. */
  walRetainedCriticalBytes: number;
}

export const DEFAULT_THRESHOLDS: CheckupThresholds = {
  dataStaleHours: 26,
  diskWarnRatio: 0.8,
  diskCriticalRatio: 0.92,
  capacityWarnRatio: 0.8,
  replicationLagBytes: 50 * 1024 * 1024,
  replicationStaleSeconds: 300,
  walRetainedWarnBytes: 1024 * 1024 * 1024,
  walRetainedCriticalBytes: 8 * 1024 * 1024 * 1024,
};

function formatGiB(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

export interface CheckupInputs {
  healthy: boolean;
  status?: InstanceStatus;
  cloneCapacity?: number | null;
  /** Absent = streaming not configured; its rules are skipped. */
  replication?: ReplicationStatus;
  /**
   * Newest pool snapshot's dataStateAt. In streaming mode this is the honest
   * data-state clock — the pool's own dataStateAt froze when the dump
   * pipeline was removed. null = listing failed this round (rule skipped
   * rather than evaluated against the wrong clock).
   */
  latestSnapshotAt?: string | null;
  /** Injected clock for tests; defaults to Date.now(). */
  now?: number;
}

export interface Checkup {
  ok: boolean;
  findings: Finding[];
  measuredAt: string;
}

/** DLE reports timestamps as ISO, "YYYY-MM-DD HH:MM:SS UTC", or compact 14-digit. */
function parseEngineDate(value: string | null | undefined): number | null {
  if (!value) return null;
  const raw = value.trim();
  const compact = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(raw);
  if (compact) {
    const [, y, mo, d, h, mi, s] = compact;
    return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  }
  const normalized = raw.replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.\d+)?\s*(UTC)?$/i, "$1T$2Z");
  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? null : parsed;
}

function countAlerts(alerts: unknown): number {
  if (!alerts) return 0;
  if (Array.isArray(alerts)) return alerts.length;
  if (typeof alerts === "object") return Object.keys(alerts as object).length;
  return 0;
}

export function evaluateCheckup(
  inputs: CheckupInputs,
  overrides: Partial<CheckupThresholds> = {},
): Finding[] {
  const t = { ...DEFAULT_THRESHOLDS, ...overrides };
  // Streaming deployments snapshot on a schedule (hourly-ish), so "stale"
  // means hours, not the dump era's day-plus — unless explicitly overridden.
  if (overrides.dataStaleHours === undefined && inputs.replication?.configured) {
    t.dataStaleHours = 2;
  }
  const now = inputs.now ?? Date.now();
  const findings: Finding[] = [];

  if (!inputs.healthy) {
    findings.push({
      code: "engine-unreachable",
      severity: "critical",
      message: "DBLab engine did not answer /healthz",
    });
  }

  const status = inputs.status;
  if (status) {
    const alerts = countAlerts(status.retrieving?.alerts);
    if (alerts > 0) {
      findings.push({
        code: "sync-alerts",
        severity: "warning",
        message: `engine reported ${alerts} sync alert${alerts === 1 ? "" : "s"}`,
        value: alerts,
      });
    }

    // Streaming: age of the newest snapshot (skip the round when the listing
    // failed). Dump era: the pool's own dataStateAt.
    const streaming = Boolean(inputs.replication?.configured);
    const clock = streaming ? inputs.latestSnapshotAt : status.pools?.[0]?.dataStateAt;
    const dataStateAt = streaming && inputs.latestSnapshotAt === null ? null : parseEngineDate(clock);
    if (dataStateAt !== null) {
      const ageHours = (now - dataStateAt) / 3_600_000;
      if (ageHours > t.dataStaleHours) {
        findings.push({
          code: "data-stale",
          severity: "warning",
          message: streaming
            ? `newest snapshot is ${Math.round(ageHours)}h old — is tendb-snapshotd running?`
            : `pool data state is ${Math.round(ageHours)}h old — refresh may be skipping (clones pin the pool)`,
          value: Math.round(ageHours),
          threshold: t.dataStaleHours,
        });
      }
    }

    const fs = status.pools?.[0]?.fileSystem;
    if (fs?.size) {
      const ratio = (fs.used ?? 0) / fs.size;
      if (ratio > t.diskCriticalRatio) {
        findings.push({
          code: "disk-usage",
          severity: "critical",
          message: `pool disk ${Math.round(ratio * 100)}% full — new clones will start failing`,
          value: Math.round(ratio * 100) / 100,
          threshold: t.diskCriticalRatio,
        });
      } else if (ratio > t.diskWarnRatio) {
        findings.push({
          code: "disk-usage",
          severity: "warning",
          message: `pool disk ${Math.round(ratio * 100)}% full`,
          value: Math.round(ratio * 100) / 100,
          threshold: t.diskWarnRatio,
        });
      }
    }

    const clones = status.cloning?.clones?.length ?? 0;
    const capacity = inputs.cloneCapacity;
    if (capacity && clones >= capacity) {
      findings.push({
        code: "clone-capacity",
        severity: "critical",
        message: `clone pool exhausted (${clones}/${capacity}) — branch creation will fail`,
        value: clones,
        threshold: capacity,
      });
    } else if (capacity && clones / capacity >= t.capacityWarnRatio) {
      findings.push({
        code: "clone-capacity",
        severity: "warning",
        message: `clone pool at ${clones}/${capacity}`,
        value: clones,
        threshold: capacity,
      });
    }
  }

  const repl = inputs.replication;
  if (repl?.configured) {
    if (repl.publisher && !repl.publisher.connected) {
      findings.push({
        code: "replication-publisher",
        severity: "critical",
        message: `publisher unreachable: ${repl.publisher.error ?? "no detail"}`,
      });
    }
    if (repl.subscriber && !repl.subscriber.connected) {
      findings.push({
        code: "replication-subscriber",
        severity: "critical",
        message: `subscriber unreachable: ${repl.subscriber.error ?? "no detail"}`,
      });
    }

    const sub = repl.subscriber?.subscriptions?.[0];
    if (sub && !sub.enabled) {
      findings.push({
        code: "subscription-disabled",
        severity: "critical",
        message: `subscription ${sub.name} is disabled — the stream has stopped`,
      });
    }
    if (sub && sub.applyErrors + sub.syncErrors > 0) {
      findings.push({
        code: "replication-errors",
        severity: "warning",
        message: `subscription ${sub.name} reported ${sub.applyErrors} apply / ${sub.syncErrors} sync errors`,
        value: sub.applyErrors + sub.syncErrors,
      });
    }
    if (
      sub?.secondsSinceLastMessage != null &&
      sub.secondsSinceLastMessage > t.replicationStaleSeconds
    ) {
      findings.push({
        code: "replication-stale",
        severity: "warning",
        message: `no message from the publisher for ${Math.round(sub.secondsSinceLastMessage)}s`,
        value: Math.round(sub.secondsSinceLastMessage),
        threshold: t.replicationStaleSeconds,
      });
    }

    const slots = repl.publisher?.slots ?? [];
    const activeSlot = slots.find((slot) => slot.active);
    if (repl.publisher?.connected && slots.length > 0 && !activeSlot) {
      findings.push({
        code: "slot-inactive",
        severity: "warning",
        message: `replication slot ${slots[0]!.name} is inactive — WAL is being retained`,
      });
    }
    if (activeSlot?.lagBytes != null && activeSlot.lagBytes > t.replicationLagBytes) {
      findings.push({
        code: "replication-lag",
        severity: "warning",
        message: `subscriber is ${activeSlot.lagBytes} bytes behind the publisher`,
        value: activeSlot.lagBytes,
        threshold: t.replicationLagBytes,
      });
    }

    // Every unhealed drift and stalled apply ends the same way: the slot pins
    // WAL on the publisher's disk, which can take production down or destroy
    // the stream outright — so it is reported directly, not inferred from lag.
    const invalidated = slots.find((s) => s.walStatus === "lost");
    const atRisk = slots.find((s) => s.walStatus === "unreserved");
    if (invalidated) {
      findings.push({
        code: "slot-invalidated",
        severity: "critical",
        message: `replication slot ${invalidated.name} has been invalidated (wal_status=lost) — the missing WAL is gone for good and the sync target must be reseeded from the source`,
        value: "lost",
      });
    } else if (atRisk) {
      findings.push({
        code: "slot-invalidated",
        severity: "critical",
        message: `replication slot ${atRisk.name} is past max_slot_wal_keep_size (wal_status=unreserved) — the next checkpoint can invalidate it and force a full reseed`,
        value: "unreserved",
      });
    }

    const retained = slots
      .map((s) => s.walRetainedBytes)
      .filter((b): b is number => b != null)
      .sort((a, b) => b - a)[0];
    if (retained != null && retained > t.walRetainedCriticalBytes) {
      findings.push({
        code: "wal-retained",
        severity: "critical",
        message: `replication slots are pinning ${formatGiB(retained)} of WAL on the publisher — free its disk before it fills`,
        value: retained,
        threshold: t.walRetainedCriticalBytes,
      });
    } else if (retained != null && retained > t.walRetainedWarnBytes) {
      findings.push({
        code: "wal-retained",
        severity: "warning",
        message: `replication slots are pinning ${formatGiB(retained)} of WAL on the publisher — the stream is not keeping up`,
        value: retained,
        threshold: t.walRetainedWarnBytes,
      });
    }

    // DDL never replicates, so schema drift is silent until rows hit a
    // missing relation — surface it as soon as the fingerprints diverge.
    if (repl.publisher?.tables && repl.subscriber?.tables) {
      const drift = diffSchemas(
        repl.publisher.tables,
        repl.subscriber.tables,
        repl.publisher.indexes,
        repl.subscriber.indexes,
      );
      const parts: string[] = [];
      if (drift.missing.length > 0) {
        parts.push(`missing on sync target: ${drift.missing.join(", ")} (first write pauses the stream)`);
      }
      if (drift.orphaned.length > 0) {
        parts.push(`only on sync target: ${drift.orphaned.join(", ")} (dropped upstream — collides if recreated)`);
      }
      if (drift.mismatched.length > 0) {
        parts.push(`columns differ: ${drift.mismatched.join(", ")}`);
      }
      if (drift.indexesDiffer.length > 0) {
        parts.push(`indexes differ: ${drift.indexesDiffer.join(", ")} (branches run without them)`);
      }
      if (parts.length > 0) {
        findings.push({
          code: "schema-drift",
          severity: "warning",
          message: parts.join(" · "),
          value:
            drift.missing.length +
            drift.orphaned.length +
            drift.mismatched.length +
            drift.indexesDiffer.length,
        });
      }
    }
  }

  return findings;
}

/** Gather + evaluate. Pass pre-resolved URLs to reuse a caller's tunnel. */
export async function runCheckup(
  session: ApiSession,
  opts: {
    thresholds?: Partial<CheckupThresholds>;
    replicationUrls?: ReplicationUrls;
  } = {},
): Promise<Checkup> {
  const healthy = await session.client.healthz();
  let status: InstanceStatus | undefined;
  let cloneCapacity: number | null | undefined;
  let latestSnapshotAt: string | null | undefined;
  if (healthy) {
    status = await session.client.status().catch(() => undefined);
    cloneCapacity = await clonePortCapacity(session).catch(() => undefined);
    latestSnapshotAt = await session.client
      .listSnapshots()
      .then((snapshots) => {
        const pool = snapshots
          .filter((s) => /@snapshot_/.test(s.id))
          .map((s) => s.dataStateAt)
          .filter((v): v is string => Boolean(v))
          .sort();
        return pool.length > 0 ? pool[pool.length - 1]! : undefined;
      })
      .catch(() => null); // listing blipped (e.g. engine rescan) — skip the rule
  }
  const urls = opts.replicationUrls ?? (await resolveReplicationUrls(session));
  const replication =
    urls.publisher || urls.subscriber
      ? await fetchReplicationStatus(urls.publisher ?? undefined, urls.subscriber ?? undefined, {
          includeSchema: true,
        })
      : undefined;

  const findings = evaluateCheckup(
    { healthy, status, cloneCapacity, replication, latestSnapshotAt },
    opts.thresholds,
  );
  return {
    ok: !findings.some((f) => f.severity === "critical"),
    findings,
    measuredAt: new Date().toISOString(),
  };
}

/**
 * Suppress engine-unreachable until it holds for `threshold` consecutive
 * checkups. Every snapshot ends in a ~2s engine restart (the snapshot-list
 * rescan), so a polling loop occasionally lands one probe inside that window;
 * a real outage spans consecutive ticks and still alerts on the second one.
 * Mutates `state.streak`; feed it every checkup from the same loop.
 */
export function debounceUnreachable(
  checkup: Checkup,
  state: { streak: number },
  threshold = 2,
): Checkup {
  if (!checkup.findings.some((f) => f.code === "engine-unreachable")) {
    state.streak = 0;
    return checkup;
  }
  state.streak += 1;
  if (state.streak >= threshold) return checkup;
  const findings = checkup.findings.filter((f) => f.code !== "engine-unreachable");
  return { ...checkup, ok: !findings.some((f) => f.severity === "critical"), findings };
}

/**
 * Transition semantics shared by SDK watch(), the console's alert loop, and
 * anything else that turns polled findings into events: alert on a new code
 * (or a warning escalating to critical), recover when a code clears.
 */
export function diffFindings(
  seen: Map<FindingCode, FindingSeverity>,
  current: Finding[],
): { alerts: Finding[]; recovers: FindingCode[] } {
  const alerts: Finding[] = [];
  const recovers: FindingCode[] = [];
  const byCode = new Map(current.map((f) => [f.code, f] as const));
  for (const [code, finding] of byCode) {
    const previous = seen.get(code);
    if (!previous || (previous === "warning" && finding.severity === "critical")) {
      alerts.push(finding);
    }
    seen.set(code, finding.severity);
  }
  for (const code of [...seen.keys()]) {
    if (!byCode.has(code)) {
      seen.delete(code);
      recovers.push(code);
    }
  }
  return { alerts, recovers };
}
