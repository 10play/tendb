import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { ScreenHeader } from "../components/AppShell";
import { Button } from "../components/Button";
import { Card, Stat } from "../components/Card";
import { ConfirmDialog } from "../components/Dialog";
import { Spinner } from "../components/Spinner";
import { UsageBar } from "../components/UsageBar";
import { useToast } from "../components/Toast";
import { AlertIcon, RotateIcon } from "../components/Icons";
import { ApiError, api, type ReplicationStatus, type SnapshotInfo, type SnapshotScheduleConfig } from "../lib/api";
import { formatAge, formatAgeAgo, formatBytes, formatRelative, formatTimestamp, parseEngineDate } from "../lib/format";
import { latestPoolSnapshotAt, summarizeStreamHop } from "../lib/replication";
import {
  useAppContext,
  useEngineStatus,
  useRefreshBranchViews,
  useReplication,
  useSnapshots,
} from "../lib/queries";
import { useQuery } from "@tanstack/react-query";
import { CameraIcon } from "../components/Icons";
import { useStoredState, useTicker } from "../lib/hooks";
import { storageKeys } from "../lib/storage";

export function SnapshotsScreen() {
  const context = useAppContext();
  const status = useEngineStatus();
  const snapshots = useSnapshots();
  const replication = useReplication();
  const refreshViews = useRefreshBranchViews();
  const streaming = Boolean(context.data?.liveBranch);
  const latestSnapshotAt = latestPoolSnapshotAt(snapshots.data);
  const toast = useToast();
  const now = useTicker();

  const [confirming, setConfirming] = useState(false);
  const [unsupported, setUnsupported] = useStoredState(
    storageKeys.fullRefreshUnsupported,
    false,
  );

  const pool = status.data?.pools?.[0];
  const retrieving = status.data?.retrieving;
  const fs = pool?.fileSystem;
  const usedRatio = fs?.size ? (fs.used ?? 0) / fs.size : 0;
  const alerts = countAlerts(retrieving?.alerts);

  // Fire-and-poll: the request returns instantly (oauth2-proxy cuts long
  // holds) and we watch the listing until a new pool snapshot appears.
  const [waitingSince, setWaitingSince] = useState<number | null>(null);
  const beforeIds = useRef<Set<string>>(new Set());

  const snapshotNow = useMutation({
    mutationFn: async () => {
      const listed = await api.snapshots().catch(() => null);
      beforeIds.current = new Set(
        (listed ?? snapshots.data ?? []).filter((s) => /@snapshot_/.test(s.id)).map((s) => s.id),
      );
      return api.createSnapshot();
    },
    onSuccess: () => setWaitingSince(Date.now()),
    onError: (error) =>
      toast.error("Snapshot failed", error instanceof Error ? error.message : String(error)),
  });

  useEffect(() => {
    if (waitingSince === null) return;
    const timer = setInterval(() => {
      void api
        .snapshots()
        .then((listed) => {
          const fresh = listed.find(
            (s) => /@snapshot_/.test(s.id) && !beforeIds.current.has(s.id),
          );
          if (fresh) {
            setWaitingSince(null);
            refreshViews();
            toast.success(
              `Snapshot ${fresh.id.split("@").pop()} ready`,
              `${((Date.now() - waitingSince) / 1000).toFixed(0)}s — new branches start here`,
            );
          } else if (Date.now() - waitingSince > 90_000) {
            setWaitingSince(null);
            toast.error(
              "Snapshot timed out",
              "check the engine host: systemctl status tendb-snapshotd",
            );
          }
        })
        .catch(() => {
          // The engine restarts briefly while rescanning — keep polling.
        });
    }, 2_000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waitingSince]);

  const fullRefresh = useMutation({
    mutationFn: api.fullRefresh,
    onSuccess: () => {
      refreshViews();
      toast.success(
        "Refresh started",
        "the engine will be busy for a while — clones stay up until it swaps the snapshot",
      );
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 404) {
        setUnsupported(true);
        toast.error("This engine has no full-refresh endpoint", "hiding the button");
        return;
      }
      toast.error("Refresh failed", error instanceof Error ? error.message : String(error));
    },
    onSettled: () => setConfirming(false),
  });

  const rows = useMemo(() => sortSnapshots(snapshots.data ?? []), [snapshots.data]);

  return (
    <div className="mx-auto max-w-[1400px] px-5 py-7 md:px-8">
      <ScreenHeader
        title="Snapshots"
        blurb={
          streaming
            ? "Point-in-time copies of the live sync target — a snapshot is an O(1) ZFS operation, seconds at any size. Every branch starts from one."
            : "The engine pulls production into a pool of point-in-time snapshots. Every branch you create starts from one of them."
        }
        actions={
          streaming ? (
            <Button
              variant="primary"
              busy={snapshotNow.isPending || waitingSince !== null}
              onClick={() => snapshotNow.mutate()}
              icon={<CameraIcon className="size-4" />}
            >
              Snapshot now
            </Button>
          ) : undefined
        }
      />

      <div className="mb-6 grid gap-4 md:grid-cols-3">
        <Card
          label="sync"
          action={
            unsupported || streaming ? null : (
              <Button
                size="sm"
                variant="ghost"
                busy={fullRefresh.isPending}
                onClick={() => setConfirming(true)}
                icon={<RotateIcon className="size-3.5" />}
              >
                Refresh now
              </Button>
            )
          }
        >
          <div className="grid grid-cols-2 gap-4">
            <Stat
              label="mode"
              value={retrieving?.mode ?? "—"}
              detail={retrieving?.status ? `status ${retrieving.status}` : undefined}
            />
            <Stat
              label="last refresh"
              value={formatAge(retrieving?.lastRefresh, now)}
              detail={formatTimestamp(retrieving?.lastRefresh)}
              tone="dim"
            />
          </div>
          <div className="mt-4 border-t border-line pt-3">
            {alerts > 0 ? (
              <p className="flex items-center gap-1.5 text-[12px] text-warn">
                <AlertIcon className="size-3.5 shrink-0" />
                {alerts} {alerts === 1 ? "alert" : "alerts"} reported by the engine
              </p>
            ) : (
              <p className="text-[12px] text-faint">
                Next refresh{" "}
                <span className="font-mono text-dim">{formatRelative(retrieving?.nextRefresh, now)}</span>
              </p>
            )}
          </div>
        </Card>

        <Card label="disk">
          <div className="grid grid-cols-2 gap-4">
            <Stat
              label="used"
              value={formatBytes(fs?.used)}
              detail={fs?.size ? `${Math.round(usedRatio * 100)}% of ${formatBytes(fs.size)}` : undefined}
              tone={usedRatio > 0.92 ? "danger" : usedRatio > 0.8 ? "warn" : "ink"}
            />
            <Stat label="free" value={formatBytes(fs?.free)} tone="dim" />
          </div>
          <div className="mt-auto pt-4">
            <UsageBar ratio={usedRatio} />
          </div>
        </Card>

        <Card label="data state">
          <div className="grid grid-cols-2 gap-4">
            {/* In streaming mode the pool's own dataStateAt froze with the
                dump pipeline; the newest snapshot is the branchable state. */}
            <Stat
              label={streaming ? "newest snapshot" : "behind production"}
              value={formatAge(streaming ? latestSnapshotAt : pool?.dataStateAt, now)}
              detail={formatTimestamp(streaming ? latestSnapshotAt : pool?.dataStateAt)}
            />
            <Stat
              label="pool"
              value={pool?.name ?? "—"}
              detail={pool?.mode ?? pool?.status ?? undefined}
              tone="dim"
            />
          </div>
        </Card>
      </div>

      {replication.data?.configured ? (
        <ReplicationCard status={replication.data} now={now} />
      ) : null}

      {streaming ? <ScheduleCard /> : null}

      <div className="overflow-hidden rounded-lg border border-line bg-panel">
        <header className="flex items-center justify-between border-b border-line px-4 py-2.5">
          <h2 className="label-eyebrow">snapshots</h2>
          <span className="font-mono text-[11px] text-faint">{rows.length}</span>
        </header>

        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="border-b border-line">
              <Th className="w-[38%]">id</Th>
              <Th className="w-[18%]">data state</Th>
              <Th className="w-[18%]">created</Th>
              <Th className="w-[13%] text-right">logical</Th>
              <Th className="w-[13%] text-right">physical</Th>
            </tr>
          </thead>
          <tbody>
            {snapshots.isLoading ? (
              <tr>
                <td colSpan={5} className="px-4 py-12 text-center text-[13px] text-dim">
                  <Spinner className="mx-auto mb-3 size-5 text-accent-ink" />
                  Listing snapshots…
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-12 text-center text-[13px] text-dim">
                  The engine has no snapshots yet. Branches cannot be created until it takes one.
                </td>
              </tr>
            ) : (
              rows.map((snapshot) => (
                <tr key={snapshot.id} className="border-b border-line last:border-b-0 hover:bg-raised/40">
                  <td className="max-w-0 truncate px-4 py-2.5 font-mono text-[12.5px] text-ink" title={snapshot.id}>
                    {snapshot.id}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-[12.5px] text-dim">
                    {formatTimestamp(snapshot.dataStateAt)}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-[12.5px] text-faint">
                    {formatAge(snapshot.createdAt, now)}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-[12.5px] text-dim">
                    {formatBytes(snapshot.logicalSize)}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-[12.5px] text-faint">
                    {formatBytes(snapshot.physicalSize)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <ConfirmDialog
        open={confirming}
        title="Refresh from production now?"
        description="The engine re-pulls the source database. It stays busy for a while and cannot take new snapshots until it finishes."
        confirmLabel="Start refresh"
        busy={fullRefresh.isPending}
        onConfirm={() => fullRefresh.mutate()}
        onCancel={() => setConfirming(false)}
      />
    </div>
  );
}

function Th({ children, className = "" }: { children: string; className?: string }) {
  return <th className={`th-tendb px-4 py-2.5 ${className}`}>{children}</th>;
}

/**
 * The hop upstream of the engine (Aurora → the engine-host sync target):
 * slot, lag, staleness and error counters, with per-side failures surfaced
 * instead of blanking the card.
 */
const INTERVAL_CHOICES = [
  { minutes: 0, label: "manual only" },
  { minutes: 15, label: "every 15 minutes" },
  { minutes: 60, label: "hourly" },
  { minutes: 360, label: "every 6 hours" },
  { minutes: 1440, label: "daily" },
];

/**
 * The executor on the engine host polls this config from SSM every few
 * seconds, so a save takes effect almost immediately — no redeploys.
 */
function ScheduleCard() {
  const toast = useToast();
  const config = useQuery({
    queryKey: ["snapshot-config"],
    queryFn: api.snapshotConfig,
    staleTime: 30_000,
  });

  const [draft, setDraft] = useState<SnapshotScheduleConfig | null>(null);
  const effective = draft ?? config.data?.config ?? { intervalMinutes: 0, retain: 24 };

  const save = useMutation({
    mutationFn: (next: SnapshotScheduleConfig) => api.saveSnapshotConfig(next),
    onSuccess: () => {
      setDraft(null);
      void config.refetch();
      toast.success("Schedule saved", "the engine host picks it up within seconds");
    },
    onError: (error) =>
      toast.error("Save failed", error instanceof Error ? error.message : String(error)),
  });

  const dirty =
    draft !== null &&
    (draft.intervalMinutes !== config.data?.config?.intervalMinutes ||
      draft.retain !== config.data?.config?.retain);

  return (
    <Card
      label="snapshot schedule"
      className="mb-6"
      action={
        <Button
          size="sm"
          variant="primary"
          disabled={!dirty}
          busy={save.isPending}
          onClick={() => save.mutate(effective)}
        >
          Save
        </Button>
      }
    >
      <div className="flex flex-wrap items-end gap-6">
        <label className="flex flex-col gap-1.5">
          <span className="label-eyebrow">interval</span>
          <select
            value={effective.intervalMinutes}
            disabled={config.isLoading}
            onChange={(event) =>
              setDraft({ ...effective, intervalMinutes: Number(event.target.value) })
            }
            className="h-8 rounded-md border border-line-strong bg-canvas px-2.5 text-[13px] text-ink focus:border-accent/60 focus:outline-none"
          >
            {INTERVAL_CHOICES.map((choice) => (
              <option key={choice.minutes} value={choice.minutes}>
                {choice.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="label-eyebrow">retain</span>
          <input
            type="number"
            min={1}
            max={500}
            value={effective.retain}
            disabled={config.isLoading}
            onChange={(event) => setDraft({ ...effective, retain: Number(event.target.value) })}
            className="h-8 w-24 rounded-md border border-line-strong bg-canvas px-2.5 text-[13px] text-ink focus:border-accent/60 focus:outline-none"
          />
        </label>

        <p className="max-w-sm pb-1 text-[12px] leading-snug text-faint">
          Snapshots in use by a branch are never pruned. A snapshot is O(1) at any
          database size, so tight intervals are cheap.
        </p>
      </div>
    </Card>
  );
}

function ReplicationCard({ status, now }: { status: ReplicationStatus; now: number }) {
  const hop = summarizeStreamHop(status);
  const slot = status.publisher?.slots?.find((s) => s.active) ?? status.publisher?.slots?.[0];
  const subscription = status.subscriber?.subscriptions?.[0];
  const toneMap = { accent: "accent", warn: "warn", danger: "danger", dim: "dim" } as const;

  return (
    <Card
      label="upstream replication"
      className="mb-6"
      action={
        <span className="font-mono text-[11px] text-faint">
          measured {formatAgeAgo(status.measuredAt, now)}
        </span>
      }
    >
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label="stream" value={hop.label} detail={hop.detail ?? undefined} tone={toneMap[hop.tone]} />
        <Stat
          label="slot"
          value={slot?.name ?? "—"}
          detail={slot ? (slot.active ? "active" : "inactive") : undefined}
          tone={slot?.active ? "ink" : "warn"}
        />
        <Stat
          label="behind publisher"
          value={slot?.lagBytes != null ? formatBytes(slot.lagBytes) : "—"}
          detail={status.publisher?.currentLsn ? `head ${status.publisher.currentLsn}` : undefined}
        />
        <Stat
          label="last message"
          value={subscription?.lastMessageAt ? formatAge(subscription.lastMessageAt, now) : "—"}
          detail={
            subscription
              ? `${subscription.applyErrors} apply · ${subscription.syncErrors} sync errors`
              : undefined
          }
          tone={subscription && subscription.applyErrors + subscription.syncErrors > 0 ? "warn" : "dim"}
        />
      </div>
      {status.publisher?.error || status.subscriber?.error ? (
        <p className="mt-4 border-t border-line pt-3 font-mono text-[11.5px] break-words text-danger">
          {status.publisher?.error ?? status.subscriber?.error}
        </p>
      ) : null}
    </Card>
  );
}

/** `alerts` is untyped in the engine response — count whichever shape arrives. */
function countAlerts(alerts: unknown): number {
  if (!alerts) return 0;
  if (Array.isArray(alerts)) return alerts.length;
  if (typeof alerts === "object") return Object.keys(alerts as object).length;
  return 0;
}

function sortSnapshots(snapshots: SnapshotInfo[]): SnapshotInfo[] {
  return [...snapshots].sort((a, b) => {
    const left = parseEngineDate(a.dataStateAt ?? a.createdAt)?.getTime() ?? 0;
    const right = parseEngineDate(b.dataStateAt ?? b.createdAt)?.getTime() ?? 0;
    return right - left;
  });
}
