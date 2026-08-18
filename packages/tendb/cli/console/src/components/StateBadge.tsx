/**
 * Clone state as a dot-and-label pill. The engine's own code (OK, CREATING…)
 * is kept in the title attribute; the label reads as a word because that is
 * what a state column is for.
 */
const LABELS: Record<string, string> = {
  OK: "Active",
  CREATING: "Creating",
  RESETTING: "Resetting",
  DELETING: "Deleting",
  EXPORTING: "Exporting",
  FATAL: "Fatal",
};

/** Live main: served straight from the streaming sync target, seconds behind
 *  the source — the one branch that moves on its own. */
export function LiveBadge() {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full bg-accent/15 px-2 py-0.5 text-[11.5px] font-medium text-accent-ink"
      title="Served from the streaming sync target — read-only, seconds behind the source"
    >
      <span className="size-1.5 animate-pulse rounded-full bg-accent" />
      Live
    </span>
  );
}

export function StateBadge({ code, message }: { code?: string; message?: string }) {
  if (!code) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-line-strong px-2 py-0.5 text-[11.5px] text-faint">
        <span className="size-1.5 rounded-full border border-faint" />
        No clone
      </span>
    );
  }

  const normalized = code.toUpperCase();
  const label = LABELS[normalized] ?? normalized;
  const tone =
    normalized === "OK" ? "text-ink" : normalized === "FATAL" ? "text-danger" : "text-warn";
  const dot =
    normalized === "OK" ? "bg-accent" : normalized === "FATAL" ? "bg-danger" : "bg-warn";
  const pulse = normalized === "CREATING" || normalized === "RESETTING" || normalized === "DELETING";

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full bg-raised px-2 py-0.5 text-[11.5px] font-medium ${tone}`}
      title={message ? `${normalized} — ${message}` : normalized}
    >
      <span className={`size-1.5 rounded-full ${dot} ${pulse ? "animate-pulse" : ""}`} />
      {label}
    </span>
  );
}
