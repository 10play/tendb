import type { ResolvedConfig } from "./config.js";
import { DblabClient } from "./dblab/client.js";
import { TenDBError, UsageError } from "./errors.js";
import type { SsmFacade } from "./aws/params.js";
import type { ParamStore, TransportName, Tunnel } from "./platform/types.js";
import { createAdapter } from "./platform/index.js";
import { discover } from "./platform/discover.js";
import { derivePassword } from "./naming.js";

export const API_PORT = 2345;
export const UI_PORT = 2346;

/**
 * A live connection to a DBLab engine: the API client plus everything needed
 * to mint clone credentials and reach clone Postgres ports.
 */
export interface ApiSession {
  client: DblabClient;
  /** Base URL the client talks to (local tunnel endpoint or --api-url). */
  apiBaseUrl: string;
  config: ResolvedConfig;
  /** "ssm" (aws), "iap" (gcp), "bastion" (azure), "local", or "direct" (--api-url). */
  transport: TransportName;
  /** Whether openClonePort works — true on every platform session, false in direct mode. */
  canTunnel: boolean;
  /** Database name inside clones; throws with guidance when unresolvable. */
  database(): string;
  /** The engine verification token (needed by `ui` and the console proxy). */
  token: string;
  derivePassword(cloneId: string): string;
  /** Forward a clone's Postgres port (platform sessions only). */
  openClonePort(remotePort: number, localPort?: number): Promise<Tunnel>;
  /** Engine-contract param store (absent in direct mode). */
  params?: ParamStore;
  /** Discovered tunnel target (EC2 id / GCP instance path / Azure VM id / container name). */
  instanceId?: string;
  /** @deprecated AWS-only alias of `params`, kept for SDK back-compat. */
  ssm?: SsmFacade;
  close(): Promise<void>;
}

export async function openSession(cfg: ResolvedConfig): Promise<ApiSession> {
  if (cfg.apiUrl) return openDirectSession(cfg);
  return openPlatformSession(cfg);
}

/**
 * How many clones the host can run at once, read from the `port-pool`
 * contract parameter ("6000-6009" → 10). Undefined in direct mode or when the
 * parameter is absent — callers show a bare count instead of "n / cap".
 */
export async function clonePortCapacity(session: ApiSession): Promise<number | undefined> {
  if (!session.params) return undefined;
  const raw = await session.params.getParameter(`${session.config.ssmPrefix}/port-pool`).catch(() => null);
  const match = raw?.match(/^(\d+)-(\d+)$/);
  if (!match) return undefined;
  return Number(match[2]) - Number(match[1]) + 1;
}

function requireDatabase(name: string | undefined): string {
  if (!name) {
    throw new TenDBError(
      "database name unknown",
      1,
      "set `database` in tendb.json, TENDB_DATABASE, or ensure the host published the `dbname` SSM parameter",
    );
  }
  return name;
}

function requireToken(token: string | undefined): string {
  if (!token) {
    throw new UsageError("direct mode (--api-url) needs a token", "set `token` in tendb.json or TENDB_TOKEN");
  }
  return token;
}

function openDirectSession(cfg: ResolvedConfig): ApiSession {
  const token = requireToken(cfg.token);
  return {
    client: new DblabClient(cfg.apiUrl!, token),
    apiBaseUrl: cfg.apiUrl!,
    config: cfg,
    transport: "direct",
    canTunnel: false,
    token,
    database: () => requireDatabase(cfg.database),
    derivePassword: (cloneId) => derivePassword(token, cloneId),
    openClonePort: async () => {
      throw new UsageError("port forwarding is unavailable in direct (--api-url) mode");
    },
    close: async () => {},
  };
}

async function openPlatformSession(cfg: ResolvedConfig): Promise<ApiSession> {
  const adapter = createAdapter(cfg);
  const found = await discover(adapter.params, cfg);
  const apiTunnel = await adapter.openTunnel(found.instanceId, API_PORT);
  const tunnels: Tunnel[] = [apiTunnel];
  return {
    client: new DblabClient(`http://127.0.0.1:${apiTunnel.localPort}`, found.token),
    apiBaseUrl: `http://127.0.0.1:${apiTunnel.localPort}`,
    config: cfg,
    transport: adapter.transport,
    canTunnel: true,
    token: found.token,
    database: () => requireDatabase(found.database),
    derivePassword: (cloneId) => derivePassword(found.token, cloneId),
    openClonePort: async (remotePort, localPort) => {
      const t = await adapter.openTunnel(found.instanceId, remotePort, localPort);
      tunnels.push(t);
      return t;
    },
    params: adapter.params,
    instanceId: found.instanceId,
    ssm: adapter.ssm,
    close: async () => {
      await Promise.all(tunnels.map((t) => t.close().catch(() => {})));
      await adapter.close().catch(() => {});
    },
  };
}
