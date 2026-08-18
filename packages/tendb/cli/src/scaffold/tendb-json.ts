import { existsSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { PLATFORMS, readConfigFile, type ConfigFile } from "../config.js";
import { TenDBError, UsageError } from "../errors.js";

/**
 * Shape of the `cli_discovery` terraform output every scaffolded template
 * emits — a JSON string of tendb.json fields. Unknown keys are dropped, null
 * values (optional outputs) are stripped after parsing.
 */
const discoverySchema = z.object({
  platform: z.enum(PLATFORMS),
  paramPrefix: z.string().nullish(),
  ssmPrefix: z.string().nullish(),
  region: z.string().nullish(),
  gcpProject: z.string().nullish(),
  azureVault: z.string().nullish(),
  stateDir: z.string().nullish(),
});

export type Discovery = { platform: (typeof PLATFORMS)[number] } & Record<string, string>;

export function parseDiscovery(raw: unknown): Discovery {
  if (typeof raw !== "string") {
    throw new TenDBError("terraform output cli_discovery is missing or not a JSON string");
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new TenDBError(`cli_discovery output is not valid JSON: ${raw}`);
  }
  const parsed = discoverySchema.safeParse(json);
  if (!parsed.success) {
    throw new TenDBError(`unexpected cli_discovery shape: ${raw}`);
  }
  return Object.fromEntries(
    Object.entries(parsed.data).filter(([, v]) => v !== null && v !== undefined),
  ) as Discovery;
}

export function writeTendbJson(path: string, obj: ConfigFile): void {
  writeFileSync(path, JSON.stringify(obj, null, 2) + "\n");
}

/**
 * `tendb init`: create tendb.json, or merge into an existing one (existing
 * keys win — the user set them; deployDir always points at the new scaffold).
 * A different configured platform needs --force (init would silently retarget
 * every command otherwise).
 */
export function createOrMergeTendbJson(
  path: string,
  initial: ConfigFile,
  opts: { force?: boolean } = {},
): "created" | "merged" {
  if (!existsSync(path)) {
    writeTendbJson(path, initial);
    return "created";
  }
  const existing = readConfigFile(path);
  if (existing.platform && existing.platform !== initial.platform && !opts.force) {
    throw new UsageError(
      `${path} is already configured for platform "${existing.platform}"`,
      `re-run with --force to retarget it to ${initial.platform}`,
    );
  }
  const merged: ConfigFile = opts.force ? { ...existing, ...initial } : { ...initial, ...existing };
  merged.deployDir = initial.deployDir;
  writeTendbJson(path, merged);
  return "merged";
}

/**
 * `tendb up`: fold the terraform cli_discovery output into tendb.json. The
 * deployment's own keys win (a re-apply may change them); everything else the
 * user set is preserved. With envName the merge lands in environments[name].
 */
export function mergeDiscovery(path: string, discovery: Discovery, envName?: string): void {
  const existing: ConfigFile = existsSync(path) ? readConfigFile(path) : {};
  const next: ConfigFile = envName
    ? {
        ...existing,
        environments: {
          ...existing.environments,
          [envName]: { ...existing.environments?.[envName], ...discovery },
        },
      }
    : { ...existing, ...discovery };
  writeTendbJson(path, next);
}
