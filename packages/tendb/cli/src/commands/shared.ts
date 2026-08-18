import type { Command } from "commander";
import { PLATFORMS, resolveConfig, type PlatformName, type ResolvedConfig } from "../config.js";
import { openSession, type ApiSession } from "../context.js";
import type { OutputFormat } from "../output.js";
import { setQuiet } from "../output.js";
import { UsageError } from "../errors.js";

export interface GlobalOpts {
  env?: string;
  platform?: string;
  region?: string;
  profile?: string;
  ssmPrefix?: string;
  instanceId?: string;
  apiUrl?: string;
  config?: string;
  output: OutputFormat;
  quiet?: boolean;
}

export function globalOpts(cmd: Command): GlobalOpts {
  const opts = cmd.optsWithGlobals() as GlobalOpts;
  if (opts.output !== "table" && opts.output !== "json") {
    throw new UsageError(`invalid --output "${opts.output}" (expected table|json)`);
  }
  return opts;
}

export function configFromCommand(cmd: Command): ResolvedConfig {
  const opts = globalOpts(cmd);
  setQuiet(Boolean(opts.quiet));
  if (opts.platform !== undefined && !(PLATFORMS as readonly string[]).includes(opts.platform)) {
    throw new UsageError(`invalid --platform "${opts.platform}"`, `expected one of: ${PLATFORMS.join(", ")}`);
  }
  return resolveConfig({
    flags: {
      env: opts.env,
      platform: opts.platform as PlatformName | undefined,
      region: opts.region,
      profile: opts.profile,
      ssmPrefix: opts.ssmPrefix,
      instanceId: opts.instanceId,
      apiUrl: opts.apiUrl,
    },
    configPath: opts.config,
  });
}

export async function withSession<T>(cmd: Command, fn: (session: ApiSession) => Promise<T>): Promise<T> {
  const session = await openSession(configFromCommand(cmd));
  try {
    return await fn(session);
  } finally {
    await session.close();
  }
}

/** Rewrite a clone URI to point at a local tunnel endpoint. */
export function localizeUri(uri: string, localPort: number): string {
  const u = new URL(uri);
  u.hostname = "127.0.0.1";
  u.port = String(localPort);
  return u.toString();
}

export function formatAge(iso: string | undefined): string {
  if (!iso) return "-";
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms) || ms < 0) return "-";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d`;
}
