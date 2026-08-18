/** Disk usage. Turns amber past 80% and red past 92% — the point where new
 *  clones start failing for want of space. */
export function UsageBar({ ratio }: { ratio: number }) {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(ratio) ? ratio : 0));
  const fill = clamped > 0.92 ? "bg-danger" : clamped > 0.8 ? "bg-warn" : "bg-accent";
  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded-full bg-raised"
      role="progressbar"
      aria-valuenow={Math.round(clamped * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label="disk used"
    >
      <div
        className={`h-full rounded-full transition-[width] duration-500 ${fill}`}
        style={{ width: `${Math.max(clamped * 100, clamped > 0 ? 2 : 0)}%` }}
      />
    </div>
  );
}
