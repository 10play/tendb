import type { ReplicationStatus, SnapshotInfo } from "./api";
import { formatBytes, formatDuration } from "./format";

/**
 * The honest data-state clock in streaming mode: the newest POOL snapshot's
 * dataStateAt. The pool's own dataStateAt froze when the dump pipeline was
 * removed, so anything still reading it shows the ghost of the last restore.
 */
export function latestPoolSnapshotAt(snapshots: SnapshotInfo[] | undefined): string | null {
  if (!snapshots) return null;
  const stamps = snapshots
    .filter((s) => /@snapshot_/.test(s.id))
    .map((s) => s.dataStateAt)
    .filter((v): v is string => Boolean(v))
    .sort();
  return stamps.length > 0 ? stamps[stamps.length - 1]! : null;
}

export type HopTone = "accent" | "warn" | "danger" | "dim";

export interface HopSummary {
  tone: HopTone;
  label: string;
  detail: string | null;
}

/**
 * Collapse publisher + subscriber telemetry into one verdict for the
 * publisher→subscriber hop. Worst signal wins: unreachable / disabled beats
 * errors beats an idle slot beats healthy streaming.
 */
export function summarizeStreamHop(status: ReplicationStatus): HopSummary {
  const pub = status.publisher;
  const sub = status.subscriber;

  if (pub && !pub.connected) {
    return { tone: "danger", label: "publisher unreachable", detail: pub.error ?? null };
  }
  if (sub && !sub.connected) {
    return { tone: "danger", label: "subscriber unreachable", detail: sub.error ?? null };
  }

  const subscription = sub?.subscriptions?.[0];
  if (sub?.subscriptions && sub.subscriptions.length === 0) {
    return { tone: "warn", label: "no subscription", detail: "CREATE SUBSCRIPTION has not run" };
  }
  if (subscription && !subscription.enabled) {
    return { tone: "danger", label: "subscription disabled", detail: subscription.name };
  }
  if (subscription && subscription.applyErrors + subscription.syncErrors > 0) {
    return {
      tone: "warn",
      label: "replication errors",
      detail: `${subscription.applyErrors} apply · ${subscription.syncErrors} sync`,
    };
  }

  const slots = pub?.slots ?? [];
  const activeSlot = slots.find((slot) => slot.active);
  if (slots.length > 0 && !activeSlot) {
    const retained = slots[0]?.walRetainedBytes ?? slots[0]?.lagBytes;
    return {
      tone: "warn",
      label: "slot inactive",
      detail: retained != null ? `${formatBytes(retained)} retained` : null,
    };
  }

  const lagBytes = activeSlot?.lagBytes ?? null;
  const staleness = subscription?.secondsSinceLastMessage ?? null;
  const parts: string[] = [];
  if (lagBytes != null) parts.push(`${formatBytes(lagBytes)} behind`);
  if (staleness != null) parts.push(`last msg ${formatDuration(Math.max(staleness, 1))} ago`);

  if (pub && slots.length === 0) {
    return { tone: "warn", label: "no replication slot", detail: "publication exists but nothing subscribed" };
  }
  return { tone: "accent", label: "streaming", detail: parts.length > 0 ? parts.join(" · ") : null };
}
