/**
 * DBLab reports timestamps in three shapes depending on the endpoint:
 * ISO 8601, "2026-08-16 14:30:00 UTC", and the compact "20260816143000" used
 * by branch listings. Everything here tolerates all three plus junk.
 */
export function parseEngineDate(value?: string | null): Date | null {
  if (!value) return null;
  const raw = value.trim();
  if (!raw) return null;

  const compact = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(raw);
  if (compact) {
    const [, y, mo, d, h, mi, s] = compact;
    return new Date(
      Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)),
    );
  }

  const spaced = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.\d+)?\s*(UTC|Z)?$/i.exec(raw);
  if (spaced) {
    const suffix = spaced[3] ? "Z" : "";
    const parsed = new Date(`${spaced[1]}T${spaced[2]}${suffix}`);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }

  const fallback = new Date(raw);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

const TIMESTAMP = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

/** Absolute local time, e.g. "Aug 16, 14:30:02". */
export function formatTimestamp(value?: string | null): string {
  const date = parseEngineDate(value);
  return date ? TIMESTAMP.format(date) : "—";
}

/** Compact elapsed time, e.g. "3h", "12m", "5d". */
export function formatAge(value?: string | null, now = Date.now()): string {
  const date = parseEngineDate(value);
  if (!date) return "—";
  const seconds = Math.round((now - date.getTime()) / 1000);
  if (seconds < 0) return formatDuration(-seconds);
  if (seconds < 45) return "just now";
  return formatDuration(seconds);
}

/** Compact duration for a second count, e.g. "45s", "12m", "3h", "5d". */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
}

/** "just now", or "3m ago" — formatAge already says "just now" by itself. */
export function formatAgeAgo(value?: string | null, now = Date.now()): string {
  const age = formatAge(value, now);
  return age === "just now" || age === "—" ? age : `${age} ago`;
}

/** Signed relative time for future or past instants: "in 42m" / "3h ago". */
export function formatRelative(value?: string | null, now = Date.now()): string {
  const date = parseEngineDate(value);
  if (!date) return "—";
  const delta = Math.round((date.getTime() - now) / 1000);
  if (Math.abs(delta) < 45) return "now";
  return delta > 0 ? `in ${formatDuration(delta)}` : `${formatDuration(-delta)} ago`;
}

const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

/** Human byte size with three significant-ish digits, e.g. "12.4 GB". */
export function formatBytes(bytes?: number | null): string {
  if (bytes === undefined || bytes === null || Number.isNaN(bytes)) return "—";
  if (bytes === 0) return "0 B";
  const exponent = Math.min(UNITS.length - 1, Math.floor(Math.log(Math.abs(bytes)) / Math.log(1024)));
  const scaled = bytes / 1024 ** exponent;
  const digits = exponent === 0 ? 0 : scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
  return `${scaled.toFixed(digits)} ${UNITS[exponent]}`;
}

const NUMBER = new Intl.NumberFormat();

export function formatCount(value: number): string {
  return NUMBER.format(value);
}

/** Hide the password in a postgres:// URI without changing its shape. */
export function maskUri(uri: string): string {
  return uri.replace(/^([a-z0-9+.-]+:\/\/[^:@/]+:)([^@]*)(@)/i, (_all, head, secret, tail) => {
    const stars = "•".repeat(Math.min(Math.max(String(secret).length, 8), 16));
    return `${head}${stars}${tail}`;
  });
}

/** Render a SQL result cell without ever throwing on exotic types. */
export function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API needs a secure context; localhost qualifies, but a proxied
    // origin might not. Fall back to the legacy selection trick.
    try {
      const scratch = document.createElement("textarea");
      scratch.value = text;
      scratch.setAttribute("readonly", "");
      scratch.style.position = "fixed";
      scratch.style.opacity = "0";
      document.body.appendChild(scratch);
      scratch.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(scratch);
      return ok;
    } catch {
      return false;
    }
  }
}
