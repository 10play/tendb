/** Typed client for the console server (same origin, 127.0.0.1). */

export interface AppContext {
  env: string | null;
  transport: "ssm" | "iap" | "bastion" | "local" | "direct";
  instanceId: string | null;
  ssmPrefix: string;
  database: string | null;
  /** Max concurrent clones (port-pool width); null when unknown. */
  cloneCapacity: number | null;
  /** Branch served live from the streaming sync target; null when no stream. */
  liveBranch: string | null;
}

export interface Clone {
  id: string;
  branch?: string;
  status: { code: string; message?: string };
  db?: { host?: string; port?: string | number; username?: string };
  createdAt?: string;
}

export interface FileSystemInfo {
  size?: number;
  free?: number;
  used?: number;
}

export interface Pool {
  name?: string;
  mode?: string;
  status?: string;
  dataStateAt?: string;
  fileSystem?: FileSystemInfo;
}

export interface EngineStatus {
  engine?: { version?: string; startedAt?: string };
  cloning?: { clones?: Clone[]; numClones?: number; expectedCloningTime?: number };
  retrieving?: {
    mode?: string;
    status?: string;
    lastRefresh?: string | null;
    nextRefresh?: string | null;
    alerts?: unknown;
  };
  pools?: Pool[];
}

export interface BranchInfo {
  name: string;
  parent?: string;
  dataStateAt?: string;
  snapshotID?: string;
  numSnapshots?: number;
}

export interface SnapshotInfo {
  id: string;
  createdAt?: string;
  dataStateAt?: string;
  logicalSize?: number;
  physicalSize?: number;
  pool?: string;
}

export interface BranchResult {
  name: string;
  state: string;
  port?: number | string;
  uri: string;
}

export interface BranchUri {
  uri: string;
  localUri: string | null;
  port: number | null;
}

export interface TableColumn {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
  isPk: boolean;
}

export interface TableInfo {
  schema: string;
  name: string;
  estRows: number;
  totalBytes: number;
  indexBytes: number;
  columns: TableColumn[];
}

export interface TablesResponse {
  tables: TableInfo[];
}

export interface ActivityBucket {
  state: string;
  count: number;
}

export interface TableStat {
  schema: string;
  name: string;
  seqScans: number;
  idxScans: number;
  liveRows: number;
  deadRows: number;
  lastAutovacuum: string | null;
  lastAutoanalyze: string | null;
}

export interface TopQuery {
  query: string;
  calls: number;
  totalMs: number;
  meanMs: number;
  rows: number;
}

export interface PerfSnapshot {
  dbBytes: number;
  /** 0..1, or null when the clone has served no reads yet. */
  cacheHitRatio: number | null;
  activity: ActivityBucket[];
  tableStats: TableStat[];
  /** null when pg_stat_statements could not be loaded; see topQueriesError. */
  topQueries: TopQuery[] | null;
  topQueriesError: string | null;
}

export interface ReplicationSlot {
  name: string;
  active: boolean;
  lagBytes: number | null;
  /** WAL kept on disk for this slot (restart_lsn → head) — grows while a slot stalls. */
  walRetainedBytes: number | null;
}

export interface ReplicationPeer {
  applicationName: string | null;
  clientAddr: string | null;
  state: string | null;
  writeLagMs: number | null;
  flushLagMs: number | null;
  replayLagMs: number | null;
}

export interface ReplicationPublisher {
  connected: boolean;
  error?: string;
  currentLsn?: string;
  slots?: ReplicationSlot[];
  peers?: ReplicationPeer[];
}

export interface ReplicationSubscription {
  name: string;
  enabled: boolean;
  receivedLsn: string | null;
  lastMessageAt: string | null;
  secondsSinceLastMessage: number | null;
  applyErrors: number;
  syncErrors: number;
}

export interface ReplicationSubscriber {
  connected: boolean;
  error?: string;
  subscriptions?: ReplicationSubscription[];
}

/** Upstream hop (e.g. Aurora → Neon) feeding the engine's dump source. */
export interface ReplicationStatus {
  configured: boolean;
  publisher?: ReplicationPublisher;
  subscriber?: ReplicationSubscriber;
  measuredAt: string;
}

export interface SnapshotScheduleConfig {
  /** 0 disables the schedule (on-demand only). */
  intervalMinutes: number;
  retain: number;
}

export interface CheckupFinding {
  code: string;
  severity: "warning" | "critical";
  message: string;
  value?: number | string;
  threshold?: number | string;
}

/** Platform health findings — same rules the SDK's checkup/watch use. */
export interface CheckupResult {
  ok: boolean;
  findings: CheckupFinding[];
  measuredAt: string;
}

export interface AlertEvent {
  at: string;
  type: "alert" | "recover";
  code: string;
  finding?: CheckupFinding;
}

export interface AlertsResponse {
  current: CheckupResult;
  /** Newest first; ring-buffered on the console server, persisted across restarts. */
  history: AlertEvent[];
  slack: { configured: boolean };
  schema: { autoSync: boolean };
}

export interface QueryOk {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
  durationMs: number;
  command?: string;
}

export interface QueryFailure {
  error: { message: string; position?: string | number | null; code?: string | null };
  durationMs: number;
}

export type QueryResult = QueryOk | QueryFailure;

export function isQueryFailure(result: QueryResult): result is QueryFailure {
  return "error" in result;
}

/** Any non-2xx from the console server, plus network failures as status 0. */
export class ApiError extends Error {
  readonly status: number;
  readonly hint: string | undefined;

  constructor(message: string, status: number, hint?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.hint = hint;
  }

  /** True when the browser never reached the console server at all. */
  get isOffline(): boolean {
    return this.status === 0;
  }
}

interface ErrorBody {
  error?: { message?: string; hint?: string };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch (cause) {
    throw new ApiError(
      `cannot reach the tendb console server (${(cause as Error).message})`,
      0,
    );
  }

  const text = await response.text();
  let body: unknown;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
  }

  if (!response.ok) {
    const failure = (body as ErrorBody | undefined)?.error;
    throw new ApiError(
      failure?.message || text.trim() || `request failed with ${response.status}`,
      response.status,
      failure?.hint,
    );
  }
  return body as T;
}

function postJson<T>(path: string, payload?: unknown): Promise<T> {
  return request<T>(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload ?? {}),
  });
}

export const api = {
  context: () => request<AppContext>("/api/context"),
  status: () => request<EngineStatus>("/api/dblab/status"),
  branches: () => request<BranchInfo[]>("/api/dblab/branches"),
  snapshots: () => request<SnapshotInfo[]>("/api/dblab/snapshots"),
  fullRefresh: () => postJson<unknown>("/api/dblab/full-refresh"),
  replication: () => request<ReplicationStatus>("/api/replication"),
  checkup: () => request<CheckupResult>("/api/checkup"),
  snapshotConfig: () => request<{ config: SnapshotScheduleConfig | null }>("/api/snapshots/config"),
  saveSnapshotConfig: (config: SnapshotScheduleConfig) =>
    request<{ config: SnapshotScheduleConfig }>("/api/snapshots/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(config),
    }),
  /** Fire-and-return; poll `snapshots()` for the new id (proxy cuts long holds). */
  createSnapshot: () => postJson<{ started: boolean }>("/api/snapshots/create"),
  alerts: () => request<AlertsResponse>("/api/alerts"),
  saveSlackWebhook: (webhookUrl: string) =>
    request<{ configured: boolean }>("/api/alerts/slack", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: webhookUrl }),
    }),
  testSlack: () => postJson<{ sent: boolean }>("/api/alerts/test"),
  /** Fire-and-return; poll `schemaDrift()` until inSync. */
  schemaSync: () => postJson<{ started: boolean }>("/api/schema/sync"),
  schemaDrift: () =>
    request<{ missing: string[]; orphaned: string[]; mismatched: string[]; inSync: boolean }>(
      "/api/schema/drift",
    ),
  saveSchemaConfig: (config: { autoSync: boolean }) =>
    request<{ config: { autoSync: boolean } }>("/api/schema/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(config),
    }),

  createBranch: (name: string, from?: string, fresh?: boolean) =>
    postJson<BranchResult>("/api/branches", { name, ...(from ? { from } : {}), ...(fresh ? { fresh } : {}) }),
  resetBranch: (name: string) =>
    postJson<BranchResult>(`/api/branches/${encodeURIComponent(name)}/reset`),
  deleteBranch: (name: string) =>
    request<{ deleted: boolean }>(`/api/branches/${encodeURIComponent(name)}`, {
      method: "DELETE",
    }),
  branchUri: (name: string) =>
    request<BranchUri>(`/api/branches/${encodeURIComponent(name)}/uri`),
  tables: (name: string) =>
    request<TablesResponse>(`/api/branches/${encodeURIComponent(name)}/tables`),
  perf: (name: string) => request<PerfSnapshot>(`/api/branches/${encodeURIComponent(name)}/perf`),

  query: (branch: string, sql: string) => postJson<QueryResult>("/api/query", { branch, sql }),
};

/** Branch names the server will accept: [a-z0-9][a-z0-9-]* up to 63 chars. */
export const BRANCH_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function validateBranchName(name: string): string | null {
  if (!name) return "Enter a branch name.";
  if (name.length > 63) return "Use 63 characters or fewer.";
  if (!BRANCH_NAME_PATTERN.test(name)) {
    return "Use lowercase letters, digits and dashes, starting with a letter or digit.";
  }
  return null;
}
