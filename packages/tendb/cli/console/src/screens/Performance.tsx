import { useMemo, useState, type ReactNode } from "react";
import { ScreenHeader } from "../components/AppShell";
import { NoCloneNotice } from "../components/BranchSelect";
import { Button } from "../components/Button";
import { Card, Stat } from "../components/Card";
import { CopyButton } from "../components/CopyButton";
import { Spinner } from "../components/Spinner";
import { AlertIcon, CloseIcon, RotateIcon } from "../components/Icons";
import type { TableStat, TopQuery } from "../lib/api";
import { formatAge, formatBytes, formatCount, formatTimestamp } from "../lib/format";
import { useSelectedBranch, usePerf } from "../lib/queries";
import { useTicker } from "../lib/hooks";
import type { ScreenId } from "../lib/hooks";

/**
 * The missing-index smell: a table big enough to matter that the planner keeps
 * reading end to end. The thresholds are deliberately loose — this marks a
 * place to look, not a verdict.
 */
function seqScanSmell(stat: TableStat): boolean {
  if (stat.liveRows < 1_000) return false;
  if (stat.seqScans < 20) return false;
  return stat.idxScans === 0 || stat.seqScans > stat.idxScans * 3;
}

function deadRatio(stat: TableStat): number {
  const total = stat.liveRows + stat.deadRows;
  return total > 0 ? stat.deadRows / total : 0;
}

export function PerformanceScreen({ onNavigate }: { onNavigate: (screen: ScreenId) => void }) {
  const { branch, branches, loading } = useSelectedBranch();
  const perf = usePerf(branch);
  const now = useTicker(10_000);

  const [dismissedNote, setDismissedNote] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);

  const data = perf.data;
  const connections = useMemo(
    () => [...(data?.activity ?? [])].sort((a, b) => b.count - a.count),
    [data],
  );
  const totalConnections = connections.reduce((sum, bucket) => sum + bucket.count, 0);
  const topQueries = useMemo(
    () => [...(data?.topQueries ?? [])].sort((a, b) => b.totalMs - a.totalMs),
    [data],
  );

  const ratio = data?.cacheHitRatio ?? null;
  // Fresh clones start with a cold cache — only genuinely disk-bound ratios warn.
  const ratioTone = ratio === null ? "dim" : ratio >= 0.97 ? "accent" : ratio >= 0.9 ? "warn" : "danger";

  return (
    <div className="mx-auto max-w-[1400px] px-5 py-7 md:px-8">
      <ScreenHeader
        title="Monitoring"
        blurb={
          branch
            ? `Counters reset when the clone starts, so everything here is ${branch}'s own workload — run it, then read its footprint.`
            : "Counters reset when the clone starts, so everything here is this branch's own workload — run it, then read its footprint."
        }
        actions={
          <Button
            variant="ghost"
            busy={perf.isFetching}
            disabled={!branch}
            onClick={() => void perf.refetch()}
            icon={<RotateIcon className="size-3.5" />}
          >
            Refresh
          </Button>
        }
      />

      {branches.length === 0 && !loading ? (
        <NoCloneNotice onGoToBranches={() => onNavigate("branches")} />
      ) : null}

      {perf.isError ? (
        <Note tone="danger">
          {perf.error instanceof Error ? perf.error.message : String(perf.error)}
        </Note>
      ) : null}

      {perf.isLoading ? (
        <div className="flex h-40 items-center justify-center rounded-lg border border-line bg-panel">
          <p className="flex items-center gap-2 text-[13px] text-dim">
            <Spinner className="size-4 text-accent-ink" />
            Collecting statistics from the clone…
          </p>
        </div>
      ) : data ? (
        <>
          <div className="mb-4 grid gap-4 md:grid-cols-3">
            <Card label="database size">
              <Stat
                label="on disk"
                value={formatBytes(data.dbBytes)}
                detail={`measured ${formatAge(new Date(perf.dataUpdatedAt).toISOString(), now)}`}
              />
            </Card>

            <Card label="cache hit ratio">
              <Stat
                label="buffer hits"
                value={ratio === null ? "—" : `${(ratio * 100).toFixed(2)}%`}
                detail={
                  ratio === null
                    ? "no reads on this clone yet"
                    : ratio >= 0.97
                      ? "healthy — reads are served from memory"
                      : "reads are reaching disk"
                }
                tone={ratioTone}
              />
            </Card>

            <Card label="connections">
              <Stat label="open" value={formatCount(totalConnections)} />
              <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 border-t border-line pt-3 font-mono text-[11px] text-faint">
                {connections.length === 0 ? (
                  <span>none reported</span>
                ) : (
                  connections.map((bucket) => (
                    <span key={bucket.state}>
                      {bucket.state} <span className="text-dim">{bucket.count}</span>
                    </span>
                  ))
                )}
              </div>
            </Card>
          </div>

          {data.topQueries === null && data.topQueriesError && !dismissedNote ? (
            <Note tone="warn" onDismiss={() => setDismissedNote(true)}>
              <span className="text-dim">Top queries are unavailable on this clone. </span>
              {data.topQueriesError}
            </Note>
          ) : null}

          <div className="mb-4 overflow-hidden rounded-lg border border-line bg-panel">
            <header className="flex items-center justify-between border-b border-line px-4 py-2.5">
              <h2 className="label-eyebrow">top queries by total time</h2>
              <span className="font-mono text-[11px] text-faint">{topQueries.length}</span>
            </header>

            {data.topQueries === null ? (
              <p className="px-4 py-8 text-center text-[13px] text-faint">
                pg_stat_statements is not available, so query timings cannot be collected.
              </p>
            ) : topQueries.length === 0 ? (
              <p className="px-4 py-8 text-center text-[13px] text-faint">
                No statements recorded yet. Run your workload against this branch and refresh.
              </p>
            ) : (
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="border-b border-line">
                    <Th className="w-[46%]">query</Th>
                    <Th className="w-[12%] text-right">calls</Th>
                    <Th className="w-[15%] text-right">total ms</Th>
                    <Th className="w-[13%] text-right">mean ms</Th>
                    <Th className="w-[14%] text-right">rows</Th>
                  </tr>
                </thead>
                <tbody>
                  {topQueries.map((query, index) => (
                    <QueryRow
                      key={index}
                      query={query}
                      slowest={topQueries[0]?.totalMs ?? 0}
                      expanded={expanded === index}
                      onToggle={() => setExpanded((current) => (current === index ? null : index))}
                    />
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="overflow-hidden rounded-lg border border-line bg-panel">
            <header className="flex items-center justify-between border-b border-line px-4 py-2.5">
              <h2 className="label-eyebrow">table activity</h2>
              <span className="font-mono text-[11px] text-faint">{data.tableStats.length}</span>
            </header>

            {data.tableStats.length === 0 ? (
              <p className="px-4 py-8 text-center text-[13px] text-faint">
                No user tables have been touched on this clone.
              </p>
            ) : (
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="border-b border-line">
                    <Th className="w-[26%]">table</Th>
                    <Th className="w-[11%] text-right">seq scans</Th>
                    <Th className="w-[11%] text-right">idx scans</Th>
                    <Th className="w-[11%] text-right">live</Th>
                    <Th className="w-[11%] text-right">dead</Th>
                    <Th className="w-[15%]">last vacuum</Th>
                    <Th className="w-[15%]">last analyze</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.tableStats.map((stat) => {
                    const smell = seqScanSmell(stat);
                    const bloated = deadRatio(stat) > 0.2;
                    return (
                      <tr
                        key={`${stat.schema}.${stat.name}`}
                        className={`border-b border-line/60 last:border-b-0 hover:bg-raised/40 ${
                          smell ? "bg-warn/10" : ""
                        }`}
                      >
                        <td className="px-4 py-2 font-mono text-[12.5px] text-ink">
                          <span className="flex items-center gap-2">
                            <span className="truncate">
                              {stat.schema === "public" ? null : (
                                <span className="text-faint">{stat.schema}.</span>
                              )}
                              {stat.name}
                            </span>
                            {smell ? (
                              <span
                                title="Mostly sequential scans on a table this size — a candidate for an index."
                                className="shrink-0 rounded border border-warn/40 px-1 py-px text-[9.5px] tracking-wide text-warn"
                              >
                                SEQ
                              </span>
                            ) : null}
                          </span>
                        </td>
                        <td
                          className={`px-4 py-2 text-right font-mono text-[12.5px] ${
                            smell ? "text-warn" : "text-dim"
                          }`}
                        >
                          {formatCount(stat.seqScans)}
                        </td>
                        <td className="px-4 py-2 text-right font-mono text-[12.5px] text-dim">
                          {formatCount(stat.idxScans)}
                        </td>
                        <td className="px-4 py-2 text-right font-mono text-[12.5px] text-dim">
                          {formatCount(stat.liveRows)}
                        </td>
                        <td
                          className={`px-4 py-2 text-right font-mono text-[12.5px] ${
                            bloated ? "text-warn" : "text-faint"
                          }`}
                          title={bloated ? "Over a fifth of this table's rows are dead." : undefined}
                        >
                          {formatCount(stat.deadRows)}
                        </td>
                        <td className="px-4 py-2 font-mono text-[11.5px] text-faint">
                          {stat.lastAutovacuum ? formatTimestamp(stat.lastAutovacuum) : "never"}
                        </td>
                        <td className="px-4 py-2 font-mono text-[11.5px] text-faint">
                          {stat.lastAutoanalyze ? formatTimestamp(stat.lastAutoanalyze) : "never"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}

function QueryRow({
  query,
  slowest,
  expanded,
  onToggle,
}: {
  query: TopQuery;
  slowest: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const share = slowest > 0 ? query.totalMs / slowest : 0;

  return (
    <>
      <tr
        onClick={onToggle}
        className="cursor-pointer border-b border-line/60 hover:bg-raised/40"
      >
        <td className="px-4 py-2">
          <button
            type="button"
            aria-expanded={expanded}
            onClick={(event) => {
              event.stopPropagation();
              onToggle();
            }}
            className="block w-full text-left"
          >
            <code
              className={`block font-mono text-[12px] leading-snug text-dim ${
                expanded ? "" : "truncate"
              }`}
            >
              {query.query}
            </code>
          </button>
          <div className="mt-1.5 h-0.5 w-full overflow-hidden rounded-full bg-raised">
            <div className="h-full rounded-full bg-accent/70" style={{ width: `${share * 100}%` }} />
          </div>
        </td>
        <td className="px-4 py-2 text-right align-top font-mono text-[12.5px] text-dim">
          {formatCount(query.calls)}
        </td>
        <td className="px-4 py-2 text-right align-top font-mono text-[12.5px] text-ink">
          {formatCount(Math.round(query.totalMs))}
        </td>
        <td className="px-4 py-2 text-right align-top font-mono text-[12.5px] text-dim">
          {Number.isFinite(query.meanMs) ? query.meanMs.toFixed(2) : "—"}
        </td>
        <td className="px-4 py-2 text-right align-top font-mono text-[12.5px] text-faint">
          {formatCount(query.rows)}
        </td>
      </tr>

      {expanded ? (
        <tr className="border-b border-line/60 bg-raised/50">
          <td colSpan={5} className="px-4 py-3">
            <pre className="mb-2 overflow-x-auto font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-dim">
              {query.query}
            </pre>
            {/* Copy only: pg_stat_statements normalises literals to $1, so this
                text is not runnable as-is. */}
            <CopyButton value={query.query} label="Copy statement" />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function Th({ children, className = "" }: { children: string; className?: string }) {
  return <th className={`th-tendb px-4 py-2.5 ${className}`}>{children}</th>;
}

function Note({
  children,
  tone,
  onDismiss,
}: {
  children: ReactNode;
  tone: "warn" | "danger";
  onDismiss?: () => void;
}) {
  const palette =
    tone === "danger" ? "border-danger/40 bg-danger/8 text-danger" : "border-warn/40 bg-warn/8 text-warn";
  return (
    <div className={`mb-4 flex items-start gap-2.5 rounded-lg border px-4 py-3 ${palette}`}>
      <AlertIcon className="mt-px size-4 shrink-0" />
      <p className="flex-1 font-mono text-[12px] leading-snug break-words">{children}</p>
      {onDismiss ? (
        <Button
          variant="quiet"
          size="sm"
          className="-my-1 -mr-1.5 px-1"
          aria-label="Dismiss"
          onClick={onDismiss}
          icon={<CloseIcon className="size-3.5" />}
        />
      ) : null}
    </div>
  );
}
