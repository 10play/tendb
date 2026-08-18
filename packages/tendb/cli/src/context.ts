import type { ResolvedConfig } from "./config.js";
import { DblabClient } from "./dblab/client.js";
import { TenDBError, UsageError } from "./errors.js";
import { createSsmFacade, discover, type SsmFacade } from "./aws/params.js";
import { startPortForward, type Tunnel } from "./aws/session.js";
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
  /** "ssm" when tunnelled through Session Manager, "direct" for --api-url. */
  transport: "ssm" | "direct";
  /** Database name inside clones; throws with guidance when unresolvable. */
  database(): string;
  /** The engine verification token (needed by `ui` and the console proxy). */
  token: string;
  derivePassword(cloneId: string): string;
  /** Forward a clone's Postgres port (SSM transport only). */
  openClonePort(remotePort: number, localPort?: number): Promise<Tunnel>;
  instanceId?: string;
  ssm?: SsmFacade;
  close(): Promise<void>;
}

export async function openSession(cfg: ResolvedConfig): Promise<ApiSession> {
  if (cfg.apiUrl) return openDirectSession(cfg);
  return openSsmSession(cfg);
}

/**
 * How many clones the host can run at once, read from the `port-pool` SSM
 * parameter ("6000-6009" → 10). Undefined in direct mode or when the
 * parameter is absent — callers show a bare count instead of "n / cap".
 */
export async function clonePortCapacity(session: ApiSession): Promise<number | undefined> {
  if (!session.ssm) return undefined;
  const raw = await session.ssm.getParameter(`${session.config.ssmPrefix}/port-pool`).catch(() => null);
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
    token,
    database: () => requireDatabase(cfg.database),
    derivePassword: (cloneId) => derivePassword(token, cloneId),
    openClonePort: async () => {
      throw new UsageError("port forwarding is unavailable in direct (--api-url) mode");
    },
    close: async () => {},
  };
}

async function openSsmSession(cfg: ResolvedConfig): Promise<ApiSession> {
  const ssm = createSsmFacade(cfg);
  const found = await discover(ssm, cfg);
  const apiTunnel = await startPortForward(ssm, { instanceId: found.instanceId, remotePort: API_PORT });
  const tunnels: Tunnel[] = [apiTunnel];
  return {
    client: new DblabClient(`http://127.0.0.1:${apiTunnel.localPort}`, found.token),
    apiBaseUrl: `http://127.0.0.1:${apiTunnel.localPort}`,
    config: cfg,
    transport: "ssm",
    token: found.token,
    database: () => requireDatabase(found.database),
    derivePassword: (cloneId) => derivePassword(found.token, cloneId),
    openClonePort: async (remotePort, localPort) => {
      const t = await startPortForward(ssm, { instanceId: found.instanceId, remotePort, localPort });
      tunnels.push(t);
      return t;
    },
    instanceId: found.instanceId,
    ssm,
    close: async () => {
      await Promise.all(tunnels.map((t) => t.close().catch(() => {})));
    },
  };
}
