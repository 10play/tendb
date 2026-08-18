import pc from "picocolors";

export type OutputFormat = "table" | "json";

let quiet = false;
export function setQuiet(value: boolean): void {
  quiet = value;
}

/** All progress/chatter goes to stderr — stdout is reserved for results. */
export function progress(message: string): void {
  if (!quiet) process.stderr.write(pc.dim(message) + "\n");
}

export function warn(message: string): void {
  process.stderr.write(pc.yellow(message) + "\n");
}

export function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

/** Minimal column formatter: pads by widest cell, dims the header. */
export function printTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const fmt = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ");
  process.stdout.write(pc.dim(fmt(headers)) + "\n");
  for (const row of rows) process.stdout.write(fmt(row) + "\n");
}

/** postgres://user:pass@host → postgres://user:****@host (for progress lines). */
export function maskUri(uri: string): string {
  return uri.replace(/(postgres(?:ql)?:\/\/[^:@/]+:)[^@]+@/, "$1****@");
}
