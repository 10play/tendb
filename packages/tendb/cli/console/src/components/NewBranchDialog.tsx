import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { ConnectionUri } from "./ConnectionUri";
import { Spinner } from "./Spinner";
import { ApiError, api, validateBranchName, type BranchResult } from "../lib/api";
import { ROOT_BRANCH } from "../lib/branches";
import { useAppContext } from "../lib/queries";

export function NewBranchDialog({
  open,
  onClose,
  branchNames,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  branchNames: string[];
  onCreated: () => void;
}) {
  const context = useAppContext();
  const streaming = Boolean(context.data?.liveBranch);

  const [name, setName] = useState("");
  const [from, setFrom] = useState(ROOT_BRANCH);
  const [fresh, setFresh] = useState(false);
  const [touched, setTouched] = useState(false);
  const [created, setCreated] = useState<BranchResult | null>(null);

  const bases = branchNames.length > 0 ? branchNames : [ROOT_BRANCH];
  const [stage, setStage] = useState<"snapshot" | "clone" | null>(null);

  const create = useMutation({
    // The fresh path is orchestrated here in two short requests (snapshot,
    // then clone) — one held request would outlive the auth proxy's timeout.
    mutationFn: async () => {
      if (fresh && from === ROOT_BRANCH) {
        setStage("snapshot");
        const before = new Set(
          (await api.snapshots().catch(() => []))
            .filter((s) => /@snapshot_/.test(s.id))
            .map((s) => s.id),
        );
        await api.createSnapshot();
        const deadline = Date.now() + 90_000;
        for (;;) {
          await new Promise((r) => setTimeout(r, 2_000));
          const listed = await api.snapshots().catch(() => null);
          if (listed?.some((s) => /@snapshot_/.test(s.id) && !before.has(s.id))) break;
          if (Date.now() > deadline) {
            throw new ApiError(
              "no new snapshot after 90s — branch not created",
              504,
              "check the engine host: systemctl status tendb-snapshotd",
            );
          }
        }
      }
      setStage("clone");
      return api.createBranch(name.trim(), from);
    },
    onSuccess: (result) => {
      setCreated(result);
      onCreated();
    },
    onSettled: () => setStage(null),
  });

  const resetForm = create.reset;
  useEffect(() => {
    if (!open) return;
    setName("");
    setTouched(false);
    setCreated(null);
    setFresh(false);
    resetForm();
    setFrom(bases.includes(ROOT_BRANCH) ? ROOT_BRANCH : (bases[0] ?? ROOT_BRANCH));
    // Deliberately keyed on `open`: the branch list refetches every 5s and must
    // not wipe what is being typed.
  }, [open, resetForm]);

  const nameError = touched ? validateBranchName(name.trim()) : null;
  const failure = create.error instanceof ApiError ? create.error : null;

  const submit = () => {
    setTouched(true);
    if (validateBranchName(name.trim())) return;
    create.mutate();
  };

  if (created) {
    return (
      <Dialog
        open={open}
        onClose={onClose}
        title={`Branch ${created.name} is ready`}
        description="Connect with this URI. It is also available from the branch row any time."
        footer={
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        }
      >
        <ConnectionUri uri={created.uri} label="connection uri" />
        <dl className="mt-4 grid grid-cols-2 gap-4">
          <div>
            <dt className="label-eyebrow mb-1">state</dt>
            <dd className="font-mono text-[13px] text-accent-ink">{created.state}</dd>
          </div>
          <div>
            <dt className="label-eyebrow mb-1">port</dt>
            <dd className="font-mono text-[13px] text-ink">{created.port ?? "—"}</dd>
          </div>
        </dl>
      </Dialog>
    );
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New branch"
      description="A branch gets its own writable clone of the latest snapshot."
      dismissible={!create.isPending}
      footer={
        <>
          <Button variant="quiet" onClick={onClose} disabled={create.isPending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} busy={create.isPending}>
            {create.isPending ? "Creating" : "Create branch"}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        className="flex flex-col gap-4"
      >
        <div>
          <label htmlFor="branch-name" className="label-eyebrow mb-1.5 block">
            branch name
          </label>
          <input
            id="branch-name"
            value={name}
            autoFocus
            spellCheck={false}
            autoComplete="off"
            disabled={create.isPending}
            placeholder="fix-checkout-totals"
            onChange={(event) => setName(event.target.value)}
            onBlur={() => setTouched(true)}
            className="w-full rounded-md border border-line bg-canvas px-3 py-2 font-mono text-[13px] text-ink placeholder:text-faint focus:border-accent/60 focus:outline-none disabled:opacity-50"
          />
          <p className={`mt-1.5 text-[12px] ${nameError ? "text-danger" : "text-faint"}`}>
            {nameError ?? "Lowercase letters, digits and dashes."}
          </p>
        </div>

        <div>
          <label htmlFor="branch-base" className="label-eyebrow mb-1.5 block">
            branch from
          </label>
          <select
            id="branch-base"
            value={from}
            disabled={create.isPending}
            onChange={(event) => setFrom(event.target.value)}
            className="w-full rounded-md border border-line bg-canvas px-3 py-2 font-mono text-[13px] text-ink focus:border-accent/60 focus:outline-none disabled:opacity-50"
          >
            {bases.map((base) => (
              <option key={base} value={base}>
                {base}
              </option>
            ))}
          </select>
        </div>

        {streaming ? (
          <label className="flex items-start gap-2.5">
            <input
              type="checkbox"
              checked={fresh && from === ROOT_BRANCH}
              disabled={create.isPending || from !== ROOT_BRANCH}
              onChange={(event) => setFresh(event.target.checked)}
              className="mt-0.5 accent-[var(--color-accent)]"
            />
            <span className="text-[12.5px] leading-snug text-dim">
              Start from the latest data — snapshot live {ROOT_BRANCH} first (~10s).
              {from !== ROOT_BRANCH ? (
                <span className="text-faint"> Only applies when branching from {ROOT_BRANCH}.</span>
              ) : null}
            </span>
          </label>
        ) : null}

        {create.isPending ? (
          <p className="flex items-center gap-2 rounded-md border border-line bg-canvas px-3 py-2.5 text-[12.5px] text-dim">
            <Spinner className="size-3.5 shrink-0 text-accent-ink" />
            {stage === "snapshot"
              ? "Snapshotting live data…"
              : fresh
                ? "Snapshot ready — creating the clone…"
                : "Creating — the first clone can take a minute."}
          </p>
        ) : null}

        {failure ? (
          <div className="rounded-md border border-danger/40 bg-danger/8 px-3 py-2.5">
            <p className="font-mono text-[12px] leading-snug break-words text-danger">
              {failure.message}
            </p>
            {failure.hint ? (
              <p className="mt-1.5 text-[12px] leading-snug text-dim">{failure.hint}</p>
            ) : null}
          </div>
        ) : null}

        <button type="submit" className="hidden" aria-hidden="true" tabIndex={-1} />
      </form>
    </Dialog>
  );
}
