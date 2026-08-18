import { useCallback } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "../components/Button";
import { NoCloneNotice } from "../components/BranchSelect";
import { ResultGrid } from "../components/ResultGrid";
import { SqlInput } from "../components/SqlInput";
import { AlertIcon, PlayIcon } from "../components/Icons";
import { BranchIcon } from "../components/Icons";
import { api, isQueryFailure, type QueryResult } from "../lib/api";
import { formatAge, formatCount } from "../lib/format";
import { useSelectedBranch } from "../lib/queries";
import { useStoredState, useTicker, type ScreenId } from "../lib/hooks";
import { storageKeys } from "../lib/storage";

interface HistoryEntry {
  sql: string;
  branch: string;
  at: number;
}

const HISTORY_LIMIT = 20;
const RUN_CHORD = navigator.userAgent.includes("Mac") ? "⌘↵" : "Ctrl+↵";

export function SqlEditorScreen({ onNavigate }: { onNavigate: (screen: ScreenId) => void }) {
  const { branch, branches, setBranch, loading } = useSelectedBranch();
  const now = useTicker(60_000);

  // Read once on mount, which is also how a statement staged by the Tables
  // screen arrives here.
  const [draft, setDraft] = useStoredState<string>(storageKeys.sqlDraft, "");
  const [history, setHistory] = useStoredState<HistoryEntry[]>(storageKeys.sqlHistory, []);

  const record = useCallback(
    (entry: HistoryEntry) => {
      const [newest] = history;
      const deduped =
        newest && newest.sql === entry.sql && newest.branch === entry.branch
          ? history.slice(1)
          : history;
      setHistory([entry, ...deduped].slice(0, HISTORY_LIMIT));
    },
    [history, setHistory],
  );

  const run = useMutation({
    mutationFn: (payload: { branch: string; sql: string }) => api.query(payload.branch, payload.sql),
    onSuccess: (_result, payload) => {
      record({ sql: payload.sql, branch: payload.branch, at: Date.now() });
    },
  });

  const runnable = Boolean(branch) && draft.trim().length > 0 && !run.isPending;

  const execute = useCallback(() => {
    const sql = draft.trim();
    if (!branch || !sql || run.isPending) return;
    run.mutate({ branch, sql });
  }, [branch, draft, run]);

  const result = run.data;
  const transportError = run.error;

  return (
    <div className="flex h-[calc(100dvh-3.5rem-4rem)] flex-col gap-4 px-5 py-6 md:h-[calc(100dvh-3.5rem)] md:px-8">
      <header className="flex flex-wrap items-center gap-3">
        <div className="mr-auto">
          <h1 className="text-[24px] leading-tight font-semibold tracking-tight text-ink">SQL Editor</h1>
          {branch ? (
            <p className="mt-0.5 flex items-center gap-1.5 text-[12px] text-faint">
              <BranchIcon className="size-3" />
              <span className="font-mono">{branch}</span>
            </p>
          ) : null}
        </div>

        <Button
          variant="primary"
          onClick={execute}
          busy={run.isPending}
          disabled={!runnable}
          icon={<PlayIcon className="size-3" />}
        >
          Run
          {/* Chip, not bare glyphs: ⌘↵ at 11px was illegible on the contrast fill. */}
          <span className="ml-1 rounded bg-on-contrast/15 px-1 py-0.5 font-mono text-[10.5px] leading-none">
            {RUN_CHORD}
          </span>
        </Button>
      </header>

      {branches.length === 0 && !loading ? (
        <NoCloneNotice onGoToBranches={() => onNavigate("branches")} />
      ) : null}

      <div className="flex min-h-0 flex-1 gap-4">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4">
          <div className="h-[34%] min-h-[9rem] shrink-0 overflow-hidden rounded-lg border border-line bg-panel">
            <SqlInput value={draft} onChange={setDraft} onRun={execute} disabled={run.isPending} />
          </div>

          <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-line bg-panel">
            <ResultBar result={result} error={transportError} pending={run.isPending} />
            <div className="min-h-0 flex-1">
              {run.isPending ? (
                <Placeholder text="Running…" />
              ) : transportError ? (
                <ErrorPanel
                  message={transportError instanceof Error ? transportError.message : String(transportError)}
                />
              ) : !result ? (
                <Placeholder text={`Write a statement and press ${RUN_CHORD}.`} />
              ) : isQueryFailure(result) ? (
                <ErrorPanel
                  message={result.error.message}
                  position={result.error.position}
                  code={result.error.code}
                />
              ) : (
                <ResultGrid result={result} />
              )}
            </div>
          </section>
        </div>

        <aside className="hidden w-60 shrink-0 flex-col overflow-hidden rounded-lg border border-line bg-panel xl:flex">
          <header className="flex items-center justify-between border-b border-line px-3 py-2.5">
            <h2 className="label-eyebrow">history</h2>
            {history.length > 0 ? (
              <button
                type="button"
                onClick={() => setHistory([])}
                className="text-[11px] text-faint transition-colors hover:text-danger"
              >
                Clear
              </button>
            ) : null}
          </header>

          {history.length === 0 ? (
            <p className="px-3 py-6 text-[12px] leading-snug text-faint">
              The last {HISTORY_LIMIT} statements you run land here.
            </p>
          ) : (
            <ul className="min-h-0 flex-1 overflow-auto">
              {history.map((entry, index) => (
                <li key={`${entry.at}-${index}`}>
                  <button
                    type="button"
                    onClick={() => {
                      setDraft(entry.sql);
                      if (branches.includes(entry.branch)) setBranch(entry.branch);
                    }}
                    className="w-full border-b border-line/60 px-3 py-2.5 text-left transition-colors hover:bg-raised"
                  >
                    <code className="line-clamp-2 block font-mono text-[11.5px] leading-snug break-words text-dim">
                      {entry.sql}
                    </code>
                    <span className="mt-1.5 flex items-center gap-1.5 font-mono text-[10px] text-faint">
                      <span className="truncate">{entry.branch}</span>
                      <span aria-hidden="true">·</span>
                      <span>{formatAge(new Date(entry.at).toISOString(), now)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>
    </div>
  );
}

function ResultBar({
  result,
  error,
  pending,
}: {
  result: QueryResult | undefined;
  error: unknown;
  pending: boolean;
}) {
  let summary = "Ready";
  if (pending) summary = "Running…";
  else if (error) summary = "Request failed";
  else if (result && isQueryFailure(result)) summary = "Statement failed";
  else if (result) {
    const parts = [
      `${formatCount(result.rowCount)} ${result.rowCount === 1 ? "row" : "rows"}`,
      `${formatCount(result.durationMs)} ms`,
    ];
    if (result.command) parts.push(result.command);
    summary = parts.join("  ·  ");
  }

  const truncated = result && !isQueryFailure(result) && result.truncated;

  return (
    <header className="flex items-center justify-between gap-3 border-b border-line px-3 py-2">
      <span className="label-eyebrow">result</span>
      <div className="flex items-center gap-3">
        {truncated ? (
          <span className="font-mono text-[11px] text-warn">first 1,000 rows only</span>
        ) : null}
        <span className="font-mono text-[11.5px] text-dim">{summary}</span>
      </div>
    </header>
  );
}

function Placeholder({ text }: { text: string }) {
  return (
    <div className="flex h-full items-center justify-center px-6 text-center">
      <p className="text-[13px] text-faint">{text}</p>
    </div>
  );
}

function ErrorPanel({
  message,
  position,
  code,
}: {
  message: string;
  position?: string | number | null;
  code?: string | null;
}) {
  return (
    <div className="h-full overflow-auto p-4">
      <div className="rounded-md border border-danger/40 bg-danger/8 p-3.5">
        <div className="mb-2 flex items-center gap-2">
          <AlertIcon className="size-4 text-danger" />
          <span className="label-eyebrow text-danger">postgres error</span>
        </div>
        <p className="font-mono text-[12.5px] leading-relaxed break-words whitespace-pre-wrap text-danger">
          {message}
        </p>
        {position || code ? (
          <p className="mt-2.5 font-mono text-[11.5px] text-faint">
            {position ? `at character ${position}` : null}
            {position && code ? "  ·  " : null}
            {code ? `sqlstate ${code}` : null}
          </p>
        ) : null}
      </div>
    </div>
  );
}
