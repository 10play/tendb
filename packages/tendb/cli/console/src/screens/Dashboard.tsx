import { useMemo, useState, type ReactNode } from "react";
import { ScreenHeader } from "../components/AppShell";
import { Button } from "../components/Button";
import { NewBranchDialog } from "../components/NewBranchDialog";
import { Spinner } from "../components/Spinner";
import { LiveBadge, StateBadge } from "../components/StateBadge";
import { UsageBar } from "../components/UsageBar";
import { BranchIcon, CloseIcon, PlusIcon, SnapshotIcon, TerminalIcon } from "../components/Icons";
import { CopyButton } from "../components/CopyButton";
import { formatAge, formatAgeAgo, formatBytes, formatRelative, formatTimestamp } from "../lib/format";
import { ROOT_BRANCH, buildBranchTree } from "../lib/branches";
import { latestPoolSnapshotAt, summarizeStreamHop, type HopSummary, type HopTone } from "../lib/replication";
import {
  useAppContext,
  useBranches,
  useEngineStatus,
  useRefreshBranchViews,
  useReplication,
  useSnapshots,
} from "../lib/queries";
import { useStoredState, useTicker, type ScreenId } from "../lib/hooks";
import { storageKeys } from "../lib/storage";

export function DashboardScreen({ onNavigate }: { onNavigate: (screen: ScreenId) => void }) {
  const context = useAppContext();
  const status = useEngineStatus();
  const branches = useBranches();
  const replication = useReplication();
  const snapshots = useSnapshots();
  const refresh = useRefreshBranchViews();
  const now = useTicker();
  const streaming = Boolean(context.data?.liveBranch);
  const latestSnapshotAt = latestPoolSnapshotAt(snapshots.data);

  const [creating, setCreating] = useState(false);
  const [dismissed, setDismissed] = useStoredState(storageKeys.gettingStartedDismissed, false);

  const clones = status.data?.cloning?.clones ?? [];
  const capacity = context.data?.cloneCapacity ?? null;
  const pool = status.data?.pools?.[0];
  const retrieving = status.data?.retrieving;
  const fs = pool?.fileSystem;
  const usedRatio = fs?.size ? (fs.used ?? 0) / fs.size : 0;

  const nodes = useMemo(
    () => buildBranchTree(branches.data ?? [], clones),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [branches.data, status.data],
  );

  return (
    <div className="mx-auto max-w-[1200px] px-5 py-7 md:px-8">
      <ScreenHeader
        title="Project dashboard"
        actions={
          <Button variant="primary" icon={<PlusIcon className="size-4" />} onClick={() => setCreating(true)}>
            New branch
          </Button>
        }
      />

      {!dismissed ? (
        <section className="mb-6 rounded-lg border border-line bg-panel p-4">
          <header className="mb-3 flex items-center justify-between">
            <h2 className="text-[13.5px] font-medium text-ink">Get connected to your branches</h2>
            <Button
              variant="quiet"
              size="sm"
              className="-my-1 px-1.5"
              aria-label="Dismiss"
              onClick={() => setDismissed(true)}
              icon={<CloseIcon className="size-3.5" />}
            />
          </header>
          <div className="grid gap-3 sm:grid-cols-3">
            <StarterCard
              icon={<TerminalIcon className="size-4 text-dim" />}
              title="Create a branch"
              blurb="A writable copy-on-write clone, ready in seconds."
              command="tendb branches create my-feature"
            />
            <StarterCard
              icon={<TerminalIcon className="size-4 text-dim" />}
              title="Open psql"
              blurb="Tunnels through SSM and connects in one step."
              command={`tendb psql ${ROOT_BRANCH}`}
            />
            <StarterCard
              icon={<TerminalIcon className="size-4 text-dim" />}
              title="Wire up CI"
              blurb="The connection URI is always the last line on stdout."
              command="tendb ci ensure $PR | tail -1"
            />
          </div>
        </section>
      ) : null}

      <section className="mb-6 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line lg:grid-cols-4">
        <Metric
          label="Branches"
          value={
            <>
              {clones.length}
              {capacity ? <span className="text-faint"> / {capacity}</span> : null}
            </>
          }
          detail="running clones"
        />
        <Metric
          label="Storage"
          value={
            <>
              {formatBytes(fs?.used)}
              {fs?.size ? <span className="text-faint"> / {formatBytes(fs.size)}</span> : null}
            </>
          }
          detail={<UsageBar ratio={usedRatio} />}
        />
        <Metric
          label="Sync"
          value={retrieving?.status ?? "—"}
          detail={retrieving?.lastRefresh ? `last refresh ${formatAge(retrieving.lastRefresh, now)} ago` : "no refresh yet"}
        />
        <Metric
          label="Data state"
          value={
            streaming
              ? latestSnapshotAt
                ? `${formatAge(latestSnapshotAt, now)} old`
                : "—"
              : pool?.dataStateAt
                ? `${formatAge(pool.dataStateAt, now)} old`
                : "—"
          }
          detail={
            streaming
              ? latestSnapshotAt
                ? `newest snapshot · ${formatTimestamp(latestSnapshotAt)}`
                : "no snapshots yet"
              : formatTimestamp(pool?.dataStateAt)
          }
        />
      </section>

      {replication.data?.configured ? (
        <section className="mb-6 rounded-lg border border-line bg-panel p-4">
          <header className="mb-4 flex items-center justify-between">
            <h2 className="text-[13.5px] font-medium text-ink">Source pipeline</h2>
            <span className="text-[11.5px] text-faint">
              measured {formatAgeAgo(replication.data.measuredAt, now)}
            </span>
          </header>
          <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center">
            <PipeNode name="aurora" role="publisher" />
            <PipeEdge hop={summarizeStreamHop(replication.data)} />
            <PipeNode
              name={context.data?.liveBranch ?? context.data?.database ?? "sync"}
              role={context.data?.liveBranch ? "live · sync target" : "sync target · engine host"}
            />
            <PipeEdge
              hop={
                streaming
                  ? snapshotHop(latestSnapshotAt, now)
                  : engineHop(retrieving?.status, retrieving?.lastRefresh, retrieving?.nextRefresh, now)
              }
            />
            <PipeNode name="branches" role="zfs clones" />
          </div>
        </section>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[3fr_2fr]">
        <section className="overflow-hidden rounded-lg border border-line bg-panel">
          <header className="flex items-center justify-between border-b border-line px-4 py-3">
            <h2 className="text-[13.5px] font-medium text-ink">
              {clones.length}
              {capacity ? ` / ${capacity}` : ""} {clones.length === 1 && !capacity ? "Branch" : "Branches"}
            </h2>
            <button
              type="button"
              onClick={() => onNavigate("branches")}
              className="text-[12.5px] font-medium text-dim transition-colors hover:text-ink"
            >
              View all
            </button>
          </header>

          {branches.isLoading || status.isLoading ? (
            <p className="flex items-center gap-2 px-4 py-8 text-[13px] text-dim">
              <Spinner className="size-4 text-accent-ink" />
              Reading branches…
            </p>
          ) : nodes.length === 0 ? (
            <div className="px-4 py-8 text-center">
              <p className="text-[13px] text-dim">No branches yet.</p>
              <Button className="mx-auto mt-3" variant="ghost" onClick={() => setCreating(true)}>
                Create the first one
              </Button>
            </div>
          ) : (
            <ul>
              {nodes.slice(0, 6).map((node) => (
                <li
                  key={node.branch.name}
                  className="flex items-center gap-2.5 border-b border-line/60 px-4 py-2.5 last:border-b-0"
                >
                  <BranchIcon className="size-3.5 shrink-0 text-faint" />
                  <span className="truncate font-mono text-[13px] text-ink">{node.branch.name}</span>
                  {node.branch.name === ROOT_BRANCH ? <DefaultBadge /> : null}
                  <span className="ml-auto flex shrink-0 items-center gap-3">
                    {node.clone?.db?.port ? (
                      <span className="font-mono text-[11.5px] text-faint">:{node.clone.db.port}</span>
                    ) : null}
                    {node.branch.name === context.data?.liveBranch ? (
                      <LiveBadge />
                    ) : (
                      <StateBadge code={node.clone?.status.code} message={node.clone?.status.message} />
                    )}
                  </span>
                </li>
              ))}
              {nodes.length > 6 ? (
                <li className="px-4 py-2.5 text-[12px] text-faint">
                  and {nodes.length - 6} more…
                </li>
              ) : null}
            </ul>
          )}
        </section>

        <section className="self-start overflow-hidden rounded-lg border border-line bg-panel">
          <header className="border-b border-line px-4 py-3">
            <h2 className="text-[13.5px] font-medium text-ink">Platform settings</h2>
          </header>
          <dl>
            <SettingRow label="Engine" value={status.data?.engine?.version ?? "—"} mono />
            <SettingRow label="Database" value={context.data?.database ?? "—"} mono />
            <SettingRow
              label="Transport"
              value={context.data ? context.data.transport.toUpperCase() : "—"}
            />
            <SettingRow label="Instance" value={context.data?.instanceId ?? "—"} mono />
            <SettingRow label="Sync mode" value={retrieving?.mode ?? "—"} />
            <SettingRow label="Next refresh" value={formatRelative(retrieving?.nextRefresh, now)} last />
          </dl>
        </section>
      </div>

      <NewBranchDialog
        open={creating}
        onClose={() => setCreating(false)}
        branchNames={nodes.map((node) => node.branch.name)}
        onCreated={refresh}
      />
    </div>
  );
}

function StarterCard({
  icon,
  title,
  blurb,
  command,
}: {
  icon: ReactNode;
  title: string;
  blurb: string;
  command: string;
}) {
  return (
    <div className="rounded-md border border-line bg-canvas p-3">
      <div className="mb-1 flex items-center gap-2">
        {icon}
        <h3 className="text-[13px] font-medium text-ink">{title}</h3>
      </div>
      <p className="mb-2.5 text-[12px] leading-snug text-faint">{blurb}</p>
      <div className="flex items-center gap-1.5 rounded-md border border-line bg-panel py-1 pr-1 pl-2">
        <code className="min-w-0 flex-1 overflow-x-auto font-mono text-[11.5px] whitespace-nowrap text-dim">
          {command}
        </code>
        <CopyButton value={command} />
      </div>
    </div>
  );
}

function Metric({ label, value, detail }: { label: string; value: ReactNode; detail?: ReactNode }) {
  return (
    <div className="bg-panel px-4 py-3.5">
      <div className="mb-1 text-[12px] text-faint">{label}</div>
      <div className="font-mono text-[15px] leading-tight text-ink">{value}</div>
      {detail ? <div className="mt-1.5 text-[11.5px] text-faint">{detail}</div> : null}
    </div>
  );
}

function SettingRow({
  label,
  value,
  mono = false,
  last = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
  last?: boolean;
}) {
  return (
    <div className={`flex items-center justify-between gap-3 px-4 py-2.5 ${last ? "" : "border-b border-line/60"}`}>
      <dt className="text-[12.5px] text-dim">{label}</dt>
      <dd className={`truncate text-[12.5px] text-ink ${mono ? "font-mono" : "font-medium"}`}>{value}</dd>
    </div>
  );
}

export function DefaultBadge() {
  return (
    <span className="shrink-0 rounded-full border border-line-strong px-2 py-0.5 text-[10.5px] font-medium text-dim">
      Default
    </span>
  );
}

/** Streaming: branches are cut from ZFS snapshots of the live sync target. */
function snapshotHop(latestSnapshotAt: string | null, now: number): HopSummary {
  if (!latestSnapshotAt) {
    return { tone: "dim", label: "zfs snapshots", detail: "no snapshots yet" };
  }
  return {
    tone: "accent",
    label: "zfs snapshots",
    detail: `newest ${formatAge(latestSnapshotAt, now)} ago · O(1) at any size`,
  };
}

/** The engine-side hop: not streaming — the scheduled dump/snapshot cadence. */
function engineHop(
  syncStatus: string | undefined,
  lastRefresh: string | null | undefined,
  nextRefresh: string | null | undefined,
  now: number,
): HopSummary {
  if (syncStatus && syncStatus !== "finished") {
    return { tone: "warn", label: syncStatus, detail: "engine is pulling the sync target" };
  }
  const parts: string[] = [];
  if (lastRefresh) parts.push(`snapshotted ${formatAge(lastRefresh, now)} ago`);
  if (nextRefresh) parts.push(`next ${formatRelative(nextRefresh, now)}`);
  return {
    tone: lastRefresh ? "accent" : "dim",
    label: "dump + snapshot",
    detail: parts.length > 0 ? parts.join(" · ") : null,
  };
}

function PipeNode({ name, role }: { name: string; role: string }) {
  return (
    <div className="flex shrink-0 items-center gap-2.5 rounded-md border border-line bg-canvas px-3.5 py-2.5">
      <SnapshotIcon className="size-4 text-faint" />
      <div className="min-w-0">
        <div className="truncate font-mono text-[12.5px] text-ink">{name}</div>
        <div className="text-[10.5px] text-faint">{role}</div>
      </div>
    </div>
  );
}

const HOP_DOT: Record<HopTone, string> = {
  accent: "bg-accent",
  warn: "bg-warn",
  danger: "bg-danger",
  dim: "bg-faint",
};
const HOP_TEXT: Record<HopTone, string> = {
  accent: "text-dim",
  warn: "text-warn",
  danger: "text-danger",
  dim: "text-faint",
};

function PipeEdge({ hop }: { hop: HopSummary }) {
  return (
    <div className="min-w-0 flex-1 px-1 sm:px-2">
      <div className={`flex items-center justify-center gap-1.5 text-[11.5px] font-medium ${HOP_TEXT[hop.tone]}`}>
        <span className={`size-1.5 rounded-full ${HOP_DOT[hop.tone]} ${hop.tone === "accent" ? "animate-pulse" : ""}`} />
        {hop.label}
      </div>
      <div className="relative mt-1.5 hidden h-px bg-line-strong sm:block">
        <span
          aria-hidden="true"
          className="absolute -top-[3.5px] right-0 border-y-4 border-l-6 border-y-transparent border-l-line-strong"
        />
      </div>
      {hop.detail ? (
        <div className="mt-1.5 truncate text-center font-mono text-[10.5px] text-faint" title={hop.detail}>
          {hop.detail}
        </div>
      ) : null}
    </div>
  );
}
