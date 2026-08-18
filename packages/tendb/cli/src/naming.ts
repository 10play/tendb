import { createHash } from "node:crypto";
import { UsageError } from "./errors.js";

/**
 * Branch names double as DBLab clone ids and (dash→underscore) Postgres role
 * names, so keep them conservative.
 */
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Numeric input is CI shorthand for a PR number: `42` → `pr-42`. */
export function normalizeBranchName(input: string): string {
  const name = /^[0-9]+$/.test(input) ? `pr-${input}` : input;
  if (!NAME_RE.test(name)) {
    throw new UsageError(
      `invalid branch name "${input}"`,
      "names must match [a-z0-9][a-z0-9-]* (max 63 chars)",
    );
  }
  return name;
}

export function dbUser(branchName: string): string {
  return branchName.replace(/-/g, "_");
}

/**
 * Clone password, derived exactly like the on-host bash pipeline
 * (`printf "%s" "$TOKEN:$CLONE_ID" | sha256sum | cut -c1-32`) so clones
 * created by either tool stay reachable by both.
 */
export function derivePassword(token: string, cloneId: string): string {
  return createHash("sha256").update(`${token}:${cloneId}`).digest("hex").slice(0, 32);
}

export function buildUri(opts: {
  user: string;
  password: string;
  host: string;
  port: number | string;
  database: string;
}): string {
  return `postgres://${opts.user}:${opts.password}@${opts.host}:${opts.port}/${opts.database}`;
}
