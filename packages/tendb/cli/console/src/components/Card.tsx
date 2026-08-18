import type { ReactNode } from "react";

/** A labelled panel. The label names an engine concept, so it's mono. */
export function Card({
  label,
  action,
  children,
  className = "",
}: {
  label: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`flex flex-col rounded-lg border border-line bg-panel p-4 ${className}`}
    >
      <header className="mb-3 flex min-h-7 items-center justify-between gap-3">
        <h2 className="label-eyebrow">{label}</h2>
        {action}
      </header>
      {children}
    </section>
  );
}

/** Label above, engine value below. The workhorse of the snapshots screen. */
export function Stat({
  label,
  value,
  detail,
  tone = "ink",
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  tone?: "ink" | "accent" | "warn" | "danger" | "dim";
}) {
  const tones = {
    ink: "text-ink",
    accent: "text-accent-ink",
    warn: "text-warn",
    danger: "text-danger",
    dim: "text-dim",
  } as const;
  return (
    <div className="min-w-0">
      <div className="label-eyebrow mb-1.5">{label}</div>
      <div className={`truncate font-mono text-[15px] leading-tight ${tones[tone]}`}>{value}</div>
      {detail ? <div className="mt-1 truncate text-[12px] text-faint">{detail}</div> : null}
    </div>
  );
}
