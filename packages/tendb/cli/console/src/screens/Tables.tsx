import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ScreenHeader } from "../components/AppShell";
import { NoCloneNotice } from "../components/BranchSelect";
import { Button } from "../components/Button";
import { ResultGrid } from "../components/ResultGrid";
import { Spinner } from "../components/Spinner";
import { AlertIcon, RotateIcon, SearchIcon, TerminalIcon } from "../components/Icons";
import { isQueryFailure, type QueryResult, type TableInfo } from "../lib/api";
import { formatBytes, formatCount } from "../lib/format";
import { previewQuery } from "../lib/sql";
import { stageSqlQuery } from "../lib/storage";
import { useSelectedBranch, useTablePreview, useTables } from "../lib/queries";
import type { ScreenId } from "../lib/hooks";

const tableKey = (table: TableInfo) => `${table.schema}.${table.name}`;

export function TablesScreen({ onNavigate }: { onNavigate: (screen: ScreenId) => void }) {
  const { branch, branches, loading } = useSelectedBranch();
  const tables = useTables(branch);

  const [filter, setFilter] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  useEffect(() => {
    setSelectedKey(null);
    setFilter("");
  }, [branch]);

  const all = useMemo(() => tables.data?.tables ?? [], [tables.data]);
  const filtered = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return all;
    return all.filter((table) => tableKey(table).toLowerCase().includes(needle));
  }, [all, filter]);

  // Resolve against the full list so typing in the filter never yanks the
  // detail pane out from under you.
  const selected = all.find((table) => tableKey(table) === selectedKey) ?? filtered[0] ?? all[0];
  const largest = all[0]?.totalBytes ?? 0;

  return (
    <div className="mx-auto max-w-[1400px] px-5 py-7 md:px-8">
      <ScreenHeader
        title="Tables"
        blurb={
          branch
            ? `What ${branch} holds and what it costs on disk. Sizes come from the clone's own catalog.`
            : "What the branch holds and what it costs on disk. Sizes come from the clone's own catalog."
        }
      />

      {branches.length === 0 && !loading ? (
        <NoCloneNotice onGoToBranches={() => onNavigate("branches")} />
      ) : null}

      {tables.isError ? (
        <ErrorNote message={tables.error instanceof Error ? tables.error.message : String(tables.error)} />
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[19rem_minmax(0,1fr)]">
        <aside className="flex max-h-[calc(100dvh-15rem)] min-h-0 flex-col overflow-hidden rounded-lg border border-line bg-panel">
          <div className="border-b border-line p-2.5">
            <div className="flex items-center gap-2 rounded-md border border-line bg-canvas px-2.5">
              <SearchIcon className="size-3.5 shrink-0 text-faint" />
              <input
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Filter tables"
                spellCheck={false}
                className="w-full bg-transparent py-1.5 font-mono text-[12px] text-ink placeholder:text-faint focus:outline-none"
              />
            </div>
          </div>

          {tables.isLoading ? (
            <p className="flex items-center gap-2 px-3 py-6 text-[12.5px] text-dim">
              <Spinner className="size-3.5 text-accent-ink" />
              Reading the catalog…
            </p>
          ) : filtered.length === 0 ? (
            <p className="px-3 py-6 text-[12.5px] text-faint">
              {!branch
                ? "Pick a branch to browse its tables."
                : all.length === 0
                  ? "This branch has no user tables."
                  : "No table matches that filter."}
            </p>
          ) : (
            <ul className="min-h-0 flex-1 overflow-auto">
              {filtered.map((table) => (
                <li key={tableKey(table)}>
                  <TableListItem
                    table={table}
                    largest={largest}
                    active={selected ? tableKey(selected) === tableKey(table) : false}
                    onSelect={() => setSelectedKey(tableKey(table))}
                  />
                </li>
              ))}
            </ul>
          )}
        </aside>

        <section className="min-w-0">
          {selected ? (
            <TableDetail
              key={tableKey(selected)}
              branch={branch}
              table={selected}
              onOpenInSql={() => {
                stageSqlQuery(branch, previewQuery(selected.schema, selected.name));
                onNavigate("sql");
              }}
            />
          ) : (
            <div className="flex h-48 items-center justify-center rounded-lg border border-line bg-panel">
              <p className="text-[13px] text-faint">
                {tables.isLoading ? "Loading…" : "Select a table to see its columns."}
              </p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

/**
 * The bar is scaled against the largest table, so the list reads as a size
 * ranking at a glance; the darker segment is the share that is index rather
 * than heap.
 */
function TableListItem({
  table,
  largest,
  active,
  onSelect,
}: {
  table: TableInfo;
  largest: number;
  active: boolean;
  onSelect: () => void;
}) {
  const heapBytes = Math.max(table.totalBytes - table.indexBytes, 0);
  const scale = largest > 0 ? 100 / largest : 0;

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? "true" : undefined}
      className={`w-full border-b border-line/60 px-3 py-2.5 text-left transition-colors ${
        active ? "bg-raised" : "hover:bg-raised/50"
      }`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className={`truncate font-mono text-[12.5px] ${active ? "text-accent-ink" : "text-ink"}`}>
          {table.schema === "public" ? null : (
            <span className="text-faint">{table.schema}.</span>
          )}
          {table.name}
        </span>
        <span className="shrink-0 font-mono text-[11px] text-dim">
          {formatBytes(table.totalBytes)}
        </span>
      </div>

      {/* Track is `raised` rather than `canvas`: it reads as recessed in dark
          and as a tint in light, whereas canvas vanishes against a white panel. */}
      <div className="mt-1.5 flex h-1 w-full overflow-hidden rounded-full bg-raised">
        <div className="bg-accent/80" style={{ width: `${heapBytes * scale}%` }} />
        <div className="bg-accent/40" style={{ width: `${table.indexBytes * scale}%` }} />
      </div>

      <div className="mt-1.5 font-mono text-[10.5px] text-faint">
        {formatCount(table.estRows)} est. rows · {formatBytes(table.indexBytes)} index
      </div>
    </button>
  );
}

function TableDetail({
  branch,
  table,
  onOpenInSql,
}: {
  branch: string;
  table: TableInfo;
  onOpenInSql: () => void;
}) {
  const preview = useTablePreview(branch, table.schema, table.name);
  const indexShare = table.totalBytes > 0 ? table.indexBytes / table.totalBytes : 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg border border-line bg-panel">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
          <h2 className="truncate font-mono text-[14px] text-ink">
            {table.schema}.{table.name}
          </h2>
          <Button size="sm" variant="ghost" onClick={onOpenInSql} icon={<TerminalIcon className="size-3.5" />}>
            Open in SQL editor
          </Button>
        </header>

        <dl className="grid grid-cols-2 gap-4 border-b border-line px-4 py-3 sm:grid-cols-4">
          <Fact label="est. rows" value={formatCount(table.estRows)} />
          <Fact label="total size" value={formatBytes(table.totalBytes)} />
          <Fact
            label="index size"
            value={formatBytes(table.indexBytes)}
            detail={`${Math.round(indexShare * 100)}% of total`}
          />
          <Fact label="columns" value={formatCount(table.columns.length)} />
        </dl>

        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="border-b border-line">
              <Th className="w-[30%]">column</Th>
              <Th className="w-[26%]">type</Th>
              <Th className="w-[14%]">null</Th>
              <Th className="w-[30%]">default</Th>
            </tr>
          </thead>
          <tbody>
            {table.columns.map((column) => (
              <tr key={column.name} className="border-b border-line/60 last:border-b-0 hover:bg-raised/40">
                <td className="px-4 py-2 font-mono text-[12.5px] text-ink">
                  <span className="flex items-center gap-2">
                    <span className="truncate">{column.name}</span>
                    {column.isPk ? (
                      <span className="shrink-0 rounded border border-accent/40 px-1 py-px text-[9.5px] tracking-wide text-accent-ink">
                        PK
                      </span>
                    ) : null}
                  </span>
                </td>
                <td className="px-4 py-2 font-mono text-[12.5px] text-dim">{column.type}</td>
                <td className="px-4 py-2 font-mono text-[11.5px]">
                  {column.nullable ? (
                    <span className="text-faint">nullable</span>
                  ) : (
                    <span className="text-dim">not null</span>
                  )}
                </td>
                <td
                  className="max-w-0 truncate px-4 py-2 font-mono text-[12px] text-faint"
                  title={column.default ?? undefined}
                >
                  {column.default ?? "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <section className="flex h-80 flex-col overflow-hidden rounded-lg border border-line bg-panel">
        <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
          <h3 className="label-eyebrow">preview · first 50 rows</h3>
          <Button
            size="sm"
            variant="quiet"
            className="px-1.5"
            aria-label="Re-run preview"
            title="Re-run preview"
            busy={preview.isFetching}
            onClick={() => void preview.refetch()}
            icon={<RotateIcon className="size-3.5" />}
          />
        </header>

        <div className="min-h-0 flex-1">
          <PreviewBody
            loading={preview.isLoading}
            error={preview.isError ? preview.error : null}
            result={preview.data}
          />
        </div>
      </section>
    </div>
  );
}

function PreviewBody({
  loading,
  error,
  result,
}: {
  loading: boolean;
  error: unknown;
  result: QueryResult | undefined;
}) {
  if (loading) {
    return (
      <Centered>
        <Spinner className="mx-auto mb-2 size-4 text-accent-ink" />
        Reading rows…
      </Centered>
    );
  }
  if (error) {
    return <Centered tone="danger">{error instanceof Error ? error.message : String(error)}</Centered>;
  }
  if (!result) return null;
  if (isQueryFailure(result)) return <Centered tone="danger">{result.error.message}</Centered>;
  return <ResultGrid result={result} />;
}

function Fact({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="min-w-0">
      <dt className="label-eyebrow mb-1">{label}</dt>
      <dd className="truncate font-mono text-[13px] text-ink">{value}</dd>
      {detail ? <dd className="mt-0.5 truncate text-[11px] text-faint">{detail}</dd> : null}
    </div>
  );
}

function Th({ children, className = "" }: { children: string; className?: string }) {
  return <th className={`th-tendb px-4 py-2.5 ${className}`}>{children}</th>;
}

function Centered({ children, tone = "dim" }: { children: ReactNode; tone?: "dim" | "danger" }) {
  return (
    <div className="flex h-full items-center justify-center px-6 text-center">
      <p className={`text-[12.5px] ${tone === "danger" ? "font-mono text-danger" : "text-dim"}`}>
        {children}
      </p>
    </div>
  );
}

function ErrorNote({ message }: { message: string }) {
  return (
    <div className="mb-4 flex items-start gap-2.5 rounded-lg border border-danger/40 bg-danger/8 px-4 py-3">
      <AlertIcon className="mt-px size-4 shrink-0 text-danger" />
      <p className="font-mono text-[12px] leading-snug break-words text-danger">{message}</p>
    </div>
  );
}
