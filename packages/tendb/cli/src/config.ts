import { readFileSync, existsSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { z } from "zod";
import { UsageError } from "./errors.js";

export const PLATFORMS = ["aws", "gcp", "azure", "local"] as const;
export type PlatformName = (typeof PLATFORMS)[number];

const environmentSchema = z
  .object({
    platform: z.enum(PLATFORMS).optional(),
    /** Canonical engine-contract namespace; `ssmPrefix` is the legacy alias. */
    paramPrefix: z.string().startsWith("/").optional(),
    ssmPrefix: z.string().startsWith("/").optional(),
    region: z.string().optional(),
    profile: z.string().optional(),
    instanceId: z.string().optional(),
    apiUrl: z.string().url().optional(),
    token: z.string().optional(),
    database: z.string().optional(),
    snapshotTimeoutSeconds: z.number().int().positive().optional(),
    cloneTimeoutSeconds: z.number().int().positive().optional(),
    replicationPublisherUrl: z.string().optional(),
    replicationSubscriberUrl: z.string().optional(),
    /** gcp: Secret Manager project (defaults to the gcloud CLI's project). */
    gcpProject: z.string().optional(),
    /** azure: Key Vault name holding the engine contract params. */
    azureVault: z.string().optional(),
    /** local: state dir with params.json (default ~/.tendb/local). */
    stateDir: z.string().optional(),
  })
  .strict();

const configFileSchema = environmentSchema
  .extend({
    environments: z.record(z.string(), environmentSchema).optional(),
  })
  .strict();

export type ConfigOverrides = z.infer<typeof environmentSchema> & { env?: string };

export interface ResolvedConfig {
  envName?: string;
  platform: PlatformName;
  /** The engine-contract namespace (canonical name; `paramPrefix` in config files). */
  ssmPrefix: string;
  region?: string;
  profile?: string;
  instanceId?: string;
  apiUrl?: string;
  token?: string;
  database?: string;
  snapshotTimeoutSeconds: number;
  cloneTimeoutSeconds: number;
  /** Upstream replication endpoints for the console's sync view (optional). */
  replicationPublisherUrl?: string;
  replicationSubscriberUrl?: string;
  gcpProject?: string;
  azureVault?: string;
  stateDir?: string;
}

const DEFAULTS = {
  platform: "aws" as PlatformName,
  ssmPrefix: "/tendb",
  snapshotTimeoutSeconds: 900,
  cloneTimeoutSeconds: 120,
};

/** Search cwd upward for tendb.json (first hit wins). */
export function findConfigFile(startDir: string): string | undefined {
  let dir = resolve(startDir);
  const { root } = parse(dir);
  for (;;) {
    const candidate = join(dir, "tendb.json");
    if (existsSync(candidate)) return candidate;
    if (dir === root) return undefined;
    dir = dirname(dir);
  }
}

function loadConfigFile(path: string): z.infer<typeof configFileSchema> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new UsageError(`cannot read config file ${path}: ${(err as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new UsageError(`invalid JSON in ${path}: ${(err as Error).message}`);
  }
  const parsed = configFileSchema.safeParse(json);
  if (!parsed.success) {
    throw new UsageError(`invalid config in ${path}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return parsed.data;
}

function parsePlatform(v: string | undefined): PlatformName | undefined {
  if (v === undefined) return undefined;
  if ((PLATFORMS as readonly string[]).includes(v)) return v as PlatformName;
  throw new UsageError(`invalid platform "${v}"`, `expected one of: ${PLATFORMS.join(", ")}`);
}

function envVarOverrides(env: NodeJS.ProcessEnv): ConfigOverrides {
  const num = (v: string | undefined) => (v ? Number(v) : undefined);
  return dropUndefined({
    env: env.TENDB_ENV,
    platform: parsePlatform(env.TENDB_PLATFORM),
    paramPrefix: env.TENDB_PARAM_PREFIX,
    ssmPrefix: env.TENDB_SSM_PREFIX,
    region: env.TENDB_REGION ?? env.AWS_REGION,
    profile: env.TENDB_PROFILE,
    instanceId: env.TENDB_INSTANCE_ID,
    apiUrl: env.TENDB_API_URL,
    token: env.TENDB_TOKEN,
    database: env.TENDB_DATABASE,
    snapshotTimeoutSeconds: num(env.TENDB_SNAPSHOT_TIMEOUT),
    cloneTimeoutSeconds: num(env.TENDB_CLONE_TIMEOUT),
    replicationPublisherUrl: env.TENDB_REPLICATION_PUBLISHER_URL,
    replicationSubscriberUrl: env.TENDB_REPLICATION_SUBSCRIBER_URL,
    gcpProject: env.TENDB_GCP_PROJECT,
    azureVault: env.TENDB_AZURE_VAULT,
    stateDir: env.TENDB_STATE_DIR,
  });
}

function dropUndefined<T extends object>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

/**
 * Precedence: flags > TENDB_* env vars > tendb.json (environment block
 * over top level) > defaults.
 */
export function resolveConfig(opts: {
  flags?: ConfigOverrides;
  configPath?: string;
  cwd?: string;
  processEnv?: NodeJS.ProcessEnv;
}): ResolvedConfig {
  const processEnv = opts.processEnv ?? process.env;
  const fromEnv = envVarOverrides(processEnv);
  const flags = dropUndefined(opts.flags ?? {});

  const path = opts.configPath ?? processEnv.TENDB_CONFIG ?? findConfigFile(opts.cwd ?? process.cwd());
  const file = path ? loadConfigFile(path) : undefined;

  const envName = flags.env ?? fromEnv.env;
  let envBlock: ConfigOverrides = {};
  if (envName) {
    const block = file?.environments?.[envName];
    if (!block) {
      throw new UsageError(
        `environment "${envName}" not found in ${path ?? "tendb.json (no config file found)"}`,
      );
    }
    envBlock = block;
  }
  const { environments: _environments, ...fileTop } = file ?? {};

  const merged = {
    ...DEFAULTS,
    ...canonicalPrefix(dropUndefined(fileTop)),
    ...canonicalPrefix(dropUndefined(envBlock)),
    ...canonicalPrefix(fromEnv),
    ...canonicalPrefix(flags),
  };
  const { env: _env, paramPrefix: _paramPrefix, ...rest } = merged;
  return { envName, ...rest };
}

/**
 * `paramPrefix` is the platform-neutral spelling of `ssmPrefix`. They are
 * folded per precedence layer (paramPrefix wins within a layer) so that a
 * higher-precedence source setting either name overrides both.
 */
function canonicalPrefix<T extends { ssmPrefix?: string; paramPrefix?: string }>(layer: T): T {
  if (!layer.paramPrefix) return layer;
  return { ...layer, ssmPrefix: layer.paramPrefix };
}
