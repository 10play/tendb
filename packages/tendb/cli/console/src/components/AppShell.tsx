import { useState, type ReactNode } from "react";
import {
  BellIcon,
  BranchIcon,
  GaugeIcon,
  GridIcon,
  PlugIcon,
  SnapshotIcon,
  TableIcon,
  TerminalIcon,
  UpDownIcon,
} from "./Icons";
import { TenDBWordmark } from "./TenDBLogo";
import { ThemeToggle } from "./ThemeToggle";
import { ConnectDialog } from "./ConnectDialog";
import type { ScreenId } from "../lib/hooks";
import type { AppContext, EngineStatus } from "../lib/api";
import { useCheckup, useSelectedBranch } from "../lib/queries";

interface NavItem {
  id: ScreenId;
  label: string;
  short: string;
  icon: typeof BranchIcon;
}

/** Engine-level screens: they read the platform, not one clone. */
const PROJECT_NAV: NavItem[] = [
  { id: "dashboard", label: "Dashboard", short: "Home", icon: GridIcon },
  { id: "branches", label: "Branches", short: "Branches", icon: BranchIcon },
  { id: "snapshots", label: "Snapshots", short: "Snaps", icon: SnapshotIcon },
  { id: "alerts", label: "Alerts", short: "Alerts", icon: BellIcon },
];

/** Clone-scoped screens: they follow the branch picked in the selector. */
const BRANCH_NAV: NavItem[] = [
  { id: "tables", label: "Tables", short: "Tables", icon: TableIcon },
  { id: "sql", label: "SQL Editor", short: "SQL", icon: TerminalIcon },
  { id: "perf", label: "Monitoring", short: "Monitor", icon: GaugeIcon },
];

const MOBILE_NAV: NavItem[] = [...PROJECT_NAV, ...BRANCH_NAV];

export function AppShell({
  context,
  status,
  screen,
  onNavigate,
  degraded = false,
  children,
}: {
  context: AppContext | undefined;
  status: EngineStatus | undefined;
  screen: ScreenId;
  onNavigate: (screen: ScreenId) => void;
  degraded?: boolean;
  children: ReactNode;
}) {
  const envLabel = context?.env ?? context?.ssmPrefix?.replace(/^\//, "") ?? null;
  const { branch, branches, setBranch } = useSelectedBranch();
  const checkup = useCheckup();
  const [connecting, setConnecting] = useState(false);

  const syncing = status?.retrieving?.status && status.retrieving.status !== "finished";
  const findings = checkup.data?.findings ?? [];
  const criticals = findings.filter((f) => f.severity === "critical").length;
  const findingsTitle = findings.map((f) => `${f.severity}: ${f.message}`).join("\n");

  return (
    <div className="flex min-h-screen flex-col bg-canvas">
      <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 bg-canvas/95 px-4 backdrop-blur">
        {/* tendb lockup: mark + "ten" lettering plus a small accent "db" — reads "tendb". */}
        <span className="flex items-end gap-0.5 text-ink" title="tendb">
          <TenDBWordmark />
          <span className="text-[13px] leading-none font-semibold tracking-tight text-accent">db</span>
        </span>

        {envLabel ? (
          <>
            <span className="mx-1 select-none text-[15px] font-light text-line-strong" aria-hidden="true">
              /
            </span>
            <span className="flex items-center gap-2">
              <span className="text-[13.5px] font-medium text-ink">{envLabel}</span>
              {context ? (
                <span className="rounded-full border border-line-strong px-2 py-0.5 text-[10.5px] font-medium tracking-wide text-dim uppercase">
                  {context.transport}
                </span>
              ) : null}
            </span>
          </>
        ) : null}
        {context?.database ? (
          <>
            <span className="mx-1 hidden select-none text-[15px] font-light text-line-strong sm:inline" aria-hidden="true">
              /
            </span>
            <span className="hidden font-mono text-[12.5px] text-dim sm:inline">{context.database}</span>
          </>
        ) : null}

        <div className="ml-auto flex items-center gap-3">
          {/* The status chip opens the Alerts screen. */}
          <button
            type="button"
            onClick={() => onNavigate("alerts")}
            title={findingsTitle || "checkup: no findings — open alerts"}
            className="rounded-md px-1.5 py-0.5 transition-colors hover:bg-raised"
          >
            {degraded ? (
              <span className="flex items-center gap-1.5 text-[12px] text-warn">
                <span className="size-1.5 animate-pulse rounded-full bg-warn" />
                Reconnecting
              </span>
            ) : criticals > 0 ? (
              <span className="flex items-center gap-1.5 text-[12px] text-danger">
                <span className="size-1.5 animate-pulse rounded-full bg-danger" />
                {criticals} critical
              </span>
            ) : findings.length > 0 ? (
              <span className="flex items-center gap-1.5 text-[12px] text-warn">
                <span className="size-1.5 rounded-full bg-warn" />
                {findings.length} {findings.length === 1 ? "warning" : "warnings"}
              </span>
            ) : syncing ? (
              <span className="flex items-center gap-1.5 text-[12px] text-dim">
                <span className="size-1.5 animate-pulse rounded-full bg-accent" />
                Syncing
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-[12px] text-dim">
                <span className="size-1.5 rounded-full bg-accent" />
                All OK
              </span>
            )}
          </button>

          {context?.instanceId ? (
            <span className="hidden truncate font-mono text-[11.5px] text-faint lg:inline" title="SSM instance">
              {context.instanceId}
            </span>
          ) : null}

          <ThemeToggle />
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <nav className="hidden w-60 shrink-0 flex-col gap-5 bg-raised px-3 pt-3 pb-4 md:flex">
          <button
            type="button"
            onClick={() => setConnecting(true)}
            className="flex h-8 w-full items-center justify-center gap-2 rounded-md border border-accent/50 text-[13.5px] font-medium text-ink transition-colors duration-100 hover:border-accent hover:bg-accent/10"
          >
            <PlugIcon className="size-4 text-accent" />
            Connect
          </button>

          <NavSection label="Project">
            {PROJECT_NAV.map((item) => (
              <NavLink key={item.id} item={item} active={item.id === screen} onNavigate={onNavigate} />
            ))}
          </NavSection>

          <NavSection label="Branch">
            {/* The branch every clone-scoped screen is pointed at. */}
            <label className="relative mb-1.5 block">
              <span className="sr-only">Working branch</span>
              <BranchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-dim" />
              <select
                value={branch}
                disabled={branches.length === 0}
                onChange={(event) => setBranch(event.target.value)}
                className="h-8 w-full appearance-none rounded-md border border-line-strong bg-transparent pr-8 pl-8 font-mono text-[12.5px] text-ink focus:border-accent/60 focus:outline-none disabled:opacity-50"
              >
                {branches.length === 0 ? <option value="">no ready clone</option> : null}
                {branches.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
              <UpDownIcon className="pointer-events-none absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 text-dim" />
            </label>

            {BRANCH_NAV.map((item) => (
              <NavLink key={item.id} item={item} active={item.id === screen} onNavigate={onNavigate} />
            ))}
          </NavSection>

          <dl className="mt-auto flex flex-col gap-2 px-2.5 font-mono text-[11px] text-faint">
            {status?.engine?.version ? (
              <div className="flex justify-between gap-2">
                <dt>dle</dt>
                <dd className="truncate">{status.engine.version}</dd>
              </div>
            ) : null}
            {context ? (
              <div className="flex justify-between gap-2">
                <dt>via</dt>
                <dd>{context.transport}</dd>
              </div>
            ) : null}
          </dl>
        </nav>

        {/* Mobile nav: the sidebar collapses to a strip of tabs. */}
        <nav className="fixed inset-x-0 bottom-0 z-30 flex border-t border-line bg-raised md:hidden">
          {MOBILE_NAV.map((item) => {
            const active = item.id === screen;
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onNavigate(item.id)}
                aria-current={active ? "page" : undefined}
                className={`flex flex-1 flex-col items-center gap-1 py-2.5 text-[10px] ${
                  active ? "text-ink" : "text-faint"
                }`}
              >
                <Icon className="size-4" />
                {item.short}
              </button>
            );
          })}
        </nav>

        <main className="min-w-0 flex-1 pb-16 md:pb-0">{children}</main>
      </div>

      <ConnectDialog
        open={connecting}
        onClose={() => setConnecting(false)}
        branches={branches}
        branch={branch}
        onPickBranch={setBranch}
      />
    </div>
  );
}

function NavSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="label-section mb-2 px-2.5">{label}</div>
      <ul className="flex flex-col gap-px">{children}</ul>
    </div>
  );
}

function NavLink({
  item,
  active,
  onNavigate,
}: {
  item: NavItem;
  active: boolean;
  onNavigate: (screen: ScreenId) => void;
}) {
  const Icon = item.icon;
  return (
    <li>
      <button
        type="button"
        onClick={() => onNavigate(item.id)}
        aria-current={active ? "page" : undefined}
        className={`flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-[13.5px] transition-colors duration-100 ${
          active ? "bg-pill text-ink" : "text-dim hover:bg-pill/50 hover:text-ink"
        }`}
      >
        <Icon className={`size-4 ${active ? "text-ink" : "text-faint"}`} />
        {item.label}
      </button>
    </li>
  );
}

/** Every screen opens the same way: a title, a sentence, and the actions. */
export function ScreenHeader({
  title,
  blurb,
  actions,
}: {
  title: ReactNode;
  blurb?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
      <div>
        <h1 className="text-[24px] leading-tight font-semibold tracking-tight text-ink">{title}</h1>
        {blurb ? <p className="mt-1 max-w-xl text-[13px] text-dim">{blurb}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}
