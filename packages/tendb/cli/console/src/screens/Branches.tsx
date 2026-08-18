import { Fragment, useMemo, useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { ScreenHeader } from "../components/AppShell";
import { Button } from "../components/Button";
import { ConfirmDialog } from "../components/Dialog";
import { ConnectionUri } from "../components/ConnectionUri";
import { NewBranchDialog } from "../components/NewBranchDialog";
import { Spinner } from "../components/Spinner";
import { LiveBadge, StateBadge } from "../components/StateBadge";
import { useToast } from "../components/Toast";
import { DefaultBadge } from "./Dashboard";
import { BranchIcon, PlugIcon, PlusIcon, RotateIcon, SearchIcon, TrashIcon } from "../components/Icons";
import { ApiError, api } from "../lib/api";
import { ROOT_BRANCH, buildBranchTree, type BranchNode } from "../lib/branches";
import { formatAge, formatTimestamp } from "../lib/format";
import {
  useAppContext,
  useBranchUri,
  useBranches,
  useEngineStatus,
  useRefreshBranchViews,
} from "../lib/queries";
import { useTicker } from "../lib/hooks";

type Pending = { kind: "reset" | "delete"; name: string } | null;

export function BranchesScreen() {
  const context = useAppContext();
  const branches = useBranches();
  const status = useEngineStatus();
  const refresh = useRefreshBranchViews();
  const toast = useToast();
  const now = useTicker();

  const [expanded, setExpanded] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [pending, setPending] = useState<Pending>(null);
  const [filter, setFilter] = useState("");

  const clones = status.data?.cloning?.clones ?? [];
  const capacity = context.data?.cloneCapacity ?? null;

  const nodes = useMemo(
    () => buildBranchTree(branches.data ?? [], clones),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [branches.data, status.data],
  );

  // Filtering flattens the lineage — a match shows even when its parent doesn't.
  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return nodes;
    return nodes.filter((node) => node.branch.name.toLowerCase().includes(needle));
  }, [nodes, filter]);

  const reportFailure = (verb: string, error: unknown) => {
    const failure = error instanceof ApiError ? error : null;
    toast.error(
      `${verb} failed`,
      failure ? [failure.message, failure.hint].filter(Boolean).join(" — ") : String(error),
    );
  };

  const ensureClone = useMutation({
    mutationFn: (name: string) => api.createBranch(name),
    onSuccess: (result) => {
      refresh();
      toast.success(`Clone ready on ${result.name}`, `port ${result.port ?? "?"}`);
    },
    onError: (error) => reportFailure("Clone", error),
  });

  const resetClone = useMutation({
    mutationFn: (name: string) => api.resetBranch(name),
    onSuccess: (result) => {
      refresh();
      toast.success(`${result.name} reset to its snapshot`);
    },
    onError: (error) => reportFailure("Reset", error),
    onSettled: () => setPending(null),
  });

  const removeBranch = useMutation({
    mutationFn: (name: string) => api.deleteBranch(name),
    onSuccess: (_result, name) => {
      refresh();
      if (expanded === name) setExpanded(null);
      toast.success(`Deleted ${name}`);
    },
    onError: (error) => reportFailure("Delete", error),
    onSettled: () => setPending(null),
  });

  const busyOn = (name: string) =>
    (ensureClone.isPending && ensureClone.variables === name) ||
    (resetClone.isPending && resetClone.variables === name) ||
    (removeBranch.isPending && removeBranch.variables === name);

  const loading = branches.isLoading || status.isLoading;

  return (
    <div className="mx-auto max-w-[1400px] px-5 py-7 md:px-8">
      <ScreenHeader
        title={
          <>
            {clones.length}
            {capacity ? <span className="text-faint"> / {capacity}</span> : null}{" "}
            {clones.length === 1 ? "Branch" : "Branches"}
          </>
        }
        blurb="Branch your data for faster experimentation. Each branch is a copy-on-write clone that costs only the pages it changes."
        actions={
          <Button variant="primary" icon={<PlusIcon className="size-4" />} onClick={() => setCreating(true)}>
            New Branch
          </Button>
        }
      />

      <div className="mb-4 flex items-center gap-2 rounded-md border border-line bg-panel px-3">
        <SearchIcon className="size-4 shrink-0 text-faint" />
        <input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Search…"
          spellCheck={false}
          className="h-9 w-full bg-transparent text-[13px] text-ink placeholder:text-faint focus:outline-none"
        />
      </div>

      <div className="overflow-hidden rounded-lg border border-line bg-panel">
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="border-b border-line">
              <Th className="w-[28%]">Branch</Th>
              <Th className="w-[12%]">Parent</Th>
              <Th className="w-[11%]">State</Th>
              <Th className="w-[7%]">Port</Th>
              <Th className="w-[16%]">Data state</Th>
              <Th className="w-[8%]">Created</Th>
              <Th className="w-[18%] text-right"> </Th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={7} className="px-4 py-14 text-center text-[13px] text-dim">
                  <Spinner className="mx-auto mb-3 size-5 text-accent-ink" />
                  Reading branches from the engine…
                </td>
              </tr>
            ) : visible.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-14 text-center">
                  {nodes.length === 0 ? (
                    <>
                      <p className="text-[13px] text-dim">No branches yet.</p>
                      <Button className="mt-3" variant="ghost" onClick={() => setCreating(true)}>
                        Create the first one
                      </Button>
                    </>
                  ) : (
                    <p className="text-[13px] text-dim">No branch matches that search.</p>
                  )}
                </td>
              </tr>
            ) : (
              visible.map((node) => (
                <Fragment key={node.branch.name}>
                  <BranchRow
                    node={node}
                    now={now}
                    live={node.branch.name === context.data?.liveBranch}
                    indent={!filter.trim()}
                    busy={busyOn(node.branch.name)}
                    expanded={expanded === node.branch.name}
                    onToggle={() =>
                      setExpanded((current) => (current === node.branch.name ? null : node.branch.name))
                    }
                    onEnsureClone={() => ensureClone.mutate(node.branch.name)}
                    onReset={() => setPending({ kind: "reset", name: node.branch.name })}
                    onDelete={() => setPending({ kind: "delete", name: node.branch.name })}
                  />
                  {expanded === node.branch.name ? (
                    <tr className="border-b border-line/60 bg-raised/50">
                      <td colSpan={7} className="px-4 py-4">
                        <ConnectionPanel name={node.branch.name} />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              ))
            )}
          </tbody>
        </table>
      </div>

      <NewBranchDialog
        open={creating}
        onClose={() => setCreating(false)}
        branchNames={nodes.map((node) => node.branch.name)}
        onCreated={refresh}
      />

      <ConfirmDialog
        open={pending?.kind === "reset"}
        title={`Reset ${pending?.name ?? ""}?`}
        description="Everything written to this clone since it was created is discarded and the data returns to the branch snapshot."
        confirmLabel="Reset clone"
        destructive
        busy={resetClone.isPending}
        onConfirm={() => pending && resetClone.mutate(pending.name)}
        onCancel={() => setPending(null)}
      />

      <ConfirmDialog
        open={pending?.kind === "delete"}
        title={`Delete ${pending?.name ?? ""}?`}
        description="The branch and its clone are removed. Open connections to it are dropped."
        confirmLabel="Delete branch"
        destructive
        busy={removeBranch.isPending}
        onConfirm={() => pending && removeBranch.mutate(pending.name)}
        onCancel={() => setPending(null)}
      />
    </div>
  );
}

function Th({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <th className={`th-tendb px-4 py-3 ${className}`}>{children}</th>;
}

function BranchRow({
  node,
  now,
  live,
  indent,
  busy,
  expanded,
  onToggle,
  onEnsureClone,
  onReset,
  onDelete,
}: {
  node: BranchNode;
  now: number;
  /** Served from the streaming sync target — no clone, no reset/delete. */
  live: boolean;
  /** Lineage indent is meaningless while a name filter reorders the rows. */
  indent: boolean;
  busy: boolean;
  expanded: boolean;
  onToggle: () => void;
  onEnsureClone: () => void;
  onReset: () => void;
  onDelete: () => void;
}) {
  const { branch, clone, depth } = node;
  const isRoot = branch.name === ROOT_BRANCH;
  const dataStateAt = branch.dataStateAt ?? clone?.createdAt;

  return (
    <tr className="border-b border-line/60 last:border-b-0 hover:bg-raised/40">
      <td className="px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          {indent && depth > 0 ? (
            <span
              aria-hidden="true"
              className="shrink-0 font-mono text-[12px] text-faint select-none"
              style={{ paddingLeft: `${(depth - 1) * 16}px` }}
            >
              └─
            </span>
          ) : null}
          <BranchIcon className="size-3.5 shrink-0 text-faint" />
          <span className="truncate font-mono text-[13px] font-medium text-ink">{branch.name}</span>
          {isRoot ? <DefaultBadge /> : null}
          {node.orphan ? (
            <span className="shrink-0 rounded-full border border-warn/40 px-2 py-0.5 text-[10.5px] font-medium text-warn">
              Unlisted
            </span>
          ) : null}
        </div>
      </td>

      <td className="px-4 py-3">
        {branch.parent ? (
          <span className="font-mono text-[12.5px] text-dim">{branch.parent}</span>
        ) : (
          <span className="text-[12.5px] text-faint">—</span>
        )}
      </td>

      <td className="px-4 py-3">
        {live ? (
          <LiveBadge />
        ) : (
          <StateBadge code={clone?.status.code} message={clone?.status.message} />
        )}
      </td>

      <td className="px-4 py-3 font-mono text-[12.5px] text-dim">{clone?.db?.port ?? "—"}</td>

      <td className="px-4 py-3">
        <span className="font-mono text-[12.5px] text-dim" title={dataStateAt ?? undefined}>
          {live ? "now — streams the source" : formatTimestamp(dataStateAt)}
        </span>
      </td>

      <td className="px-4 py-3 font-mono text-[12.5px] text-faint">
        {clone?.createdAt ? formatAge(clone.createdAt, now) : "—"}
      </td>

      <td className="px-4 py-3">
        <div className="flex items-center justify-end gap-1.5">
          {live ? (
            <Button
              size="sm"
              variant={expanded ? "primary" : "ghost"}
              onClick={onToggle}
              icon={<PlugIcon className="size-3.5" />}
              aria-expanded={expanded}
            >
              Connect
            </Button>
          ) : clone ? (
            <>
              <Button
                size="sm"
                variant={expanded ? "primary" : "ghost"}
                onClick={onToggle}
                icon={<PlugIcon className="size-3.5" />}
                aria-expanded={expanded}
              >
                Connect
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={onReset}
                busy={busy}
                title="Discard writes and return to the snapshot"
                icon={<RotateIcon className="size-3.5" />}
                aria-label={`Reset ${branch.name}`}
              />
              {!isRoot ? (
                <Button
                  size="sm"
                  variant="danger"
                  onClick={onDelete}
                  disabled={busy}
                  title="Delete branch and clone"
                  icon={<TrashIcon className="size-3.5" />}
                  aria-label={`Delete ${branch.name}`}
                />
              ) : null}
            </>
          ) : (
            <Button size="sm" variant="ghost" onClick={onEnsureClone} busy={busy}>
              Create clone
            </Button>
          )}
        </div>
      </td>
    </tr>
  );
}

function ConnectionPanel({ name }: { name: string }) {
  const uri = useBranchUri(name, true);

  if (uri.isLoading) {
    return (
      <p className="flex items-center gap-2 text-[12.5px] text-dim">
        <Spinner className="size-3.5 text-accent-ink" />
        Fetching connection details…
      </p>
    );
  }

  if (uri.isError || !uri.data) {
    const message = uri.error instanceof Error ? uri.error.message : "no connection details";
    return <p className="font-mono text-[12px] text-danger">{message}</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      <ConnectionUri uri={uri.data.uri} label="connection uri" />
      {uri.data.localUri ? (
        <ConnectionUri uri={uri.data.localUri} label="local uri (via open tunnel)" />
      ) : null}
      <p className="text-[12px] text-faint">
        Reachable through the tunnel this console holds open. Port{" "}
        <span className="font-mono text-dim">{uri.data.port ?? "—"}</span> on the engine host.
      </p>
    </div>
  );
}
