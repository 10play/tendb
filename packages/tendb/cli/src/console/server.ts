import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { clonePortCapacity, type ApiSession } from "../context.js";
import type { Tunnel } from "../aws/session.js";
import { deleteBranch, ensureBranch, getBranchClone, resetBranch } from "../dblab/workflows.js";
import { fetchReplicationStatus } from "./replication.js";
import {
  debounceUnreachable,
  diffFindings,
  runCheckup,
  type Checkup,
  type FindingCode,
  type FindingSeverity,
} from "../monitor/checkup.js";
import { postToSlack, type AlertEvent } from "../monitor/slack.js";
import { AlertStateStore } from "./alert-store.js";
import {
  getSchemaConfig,
  requestSchemaSync,
  schemaDrift,
  setSchemaConfig,
  validateSchemaConfig,
} from "../schema-sync.js";
import { resolveReplicationUrls, type ReplicationUrls } from "../replication-urls.js";
import {
  createSnapshotNow,
  requestSnapshot,
  getScheduleConfig,
  setScheduleConfig,
  snapshotSsm,
  validateScheduleConfig,
} from "../snapshots.js";
import type { SsmFacade } from "../aws/params.js";
import { localizeUri } from "../commands/shared.js";
import { TenDBError } from "../errors.js";

const QUERY_TIMEOUT_MS = 5_000;
const ROW_CAP = 1_000;
const BODY_CAP = 1_024 * 1_024;

/** The branch served live from the sync target when streaming is configured. */
const LIVE_BRANCH = "main";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

interface BranchConnection {
  tunnel: Tunnel | null;
  pool: pg.Pool;
}

/**
 * The console backend: serves the built SPA, proxies the DBLab API (injecting
 * the verification token server-side), and runs SQL against clones through
 * on-demand per-clone tunnels. Binds to 127.0.0.1 only — the token and AWS
 * credentials never reach the browser.
 */
export class ConsoleServer {
  private connections = new Map<string, BranchConnection>();
  private server: Server | undefined;
  /** Cached after the first /api/context call; null = engine has no pool param. */
  private cloneCapacity: number | null | undefined;
  /** Cached upstream-replication endpoints; null = looked up and absent. */
  private replicationUrls: ReplicationUrls | undefined;
  /** Lazy SSM facade for snapshot config/requests (works on direct transport). */
  private ssmFacade: SsmFacade | undefined;
  /** Alert loop state: last-seen severities, ring-buffered events, cadence. */
  private alertSeen = new Map<FindingCode, FindingSeverity>();
  private alertHistory: AlertEvent[] = [];
  private alertTimer: NodeJS.Timeout | undefined;
  private lastCheckup: Checkup | undefined;
  /** null = not looked up yet; undefined = looked up, none configured. */
  private consoleUrlCache: string | undefined | null = null;
  /** Consecutive unreachable checkups — see debounceUnreachable. */
  private unreachable = { streak: 0 };

  private readonly staticDir: string;
  private readonly alertStore: AlertStateStore;

  constructor(
    private readonly session: ApiSession,
    opts: { staticDir?: string; stateDir?: string } = {},
  ) {
    this.staticDir = opts.staticDir ?? fileURLToPath(new URL("./console/", import.meta.url));
    this.alertStore = new AlertStateStore(opts.stateDir);
  }

  async listen(port: number): Promise<number> {
    this.server = createServer((req, res) => {
      this.route(req, res).catch((err) => {
        sendJson(res, 500, { error: { message: (err as Error).message } });
      });
    });
    await new Promise<void>((resolveListen, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, "127.0.0.1", resolveListen);
    });
    const address = this.server.address();
    // Restore alert state BEFORE the first tick: a pre-populated seen map is
    // what stops a restart from re-announcing every active finding to Slack.
    const restored = await this.alertStore.load();
    if (restored) {
      this.alertSeen = restored.seen;
      this.alertHistory = restored.history;
    }
    // Alert loop: findings → history + optional Slack, one probe per minute.
    void this.alertTick();
    this.alertTimer = setInterval(() => void this.alertTick(), 60_000);
    return typeof address === "object" && address ? address.port : port;
  }

  private async slackWebhook(): Promise<string | null> {
    try {
      const value = await this.snapshotFacade().getParameter(
        `${this.session.config.ssmPrefix}/alerts/slack-webhook`,
        true,
      );
      // "none" is the cleared sentinel (SSM has no empty-string values).
      return value && value !== "none" ? value : null;
    } catch {
      return null;
    }
  }

  /** Public console URL for "Open console" links in Slack; optional param. */
  private async consoleUrl(): Promise<string | undefined> {
    if (this.consoleUrlCache !== null) return this.consoleUrlCache;
    try {
      const value = await this.snapshotFacade().getParameter(
        `${this.session.config.ssmPrefix}/console-url`,
      );
      this.consoleUrlCache = value && value !== "none" ? value : undefined;
    } catch {
      this.consoleUrlCache = undefined;
    }
    return this.consoleUrlCache;
  }

  private async alertTick(): Promise<void> {
    try {
      const checkup = debounceUnreachable(
        await runCheckup(this.session, { replicationUrls: await this.resolveReplication() }),
        this.unreachable,
      );
      this.lastCheckup = checkup;
      const { alerts, recovers } = diffFindings(this.alertSeen, checkup.findings);
      if (alerts.length === 0 && recovers.length === 0) {
        // diffFindings can still mutate `seen` (e.g. critical → warning
        // de-escalation), so persist before the early return.
        await this.alertStore.save(this.alertSeen, this.alertHistory);
        return;
      }

      const at = new Date().toISOString();
      const events: AlertEvent[] = [
        ...alerts.map((finding): AlertEvent => ({ at, type: "alert", code: finding.code, finding })),
        ...recovers.map((code): AlertEvent => ({ at, type: "recover", code })),
      ];
      this.alertHistory.push(...events);
      if (this.alertHistory.length > 200) {
        this.alertHistory.splice(0, this.alertHistory.length - 200);
      }
      await this.alertStore.save(this.alertSeen, this.alertHistory);
      const webhook = await this.slackWebhook();
      if (webhook) {
        const consoleUrl = await this.consoleUrl();
        for (const event of events) await postToSlack(webhook, event, fetch, { consoleUrl });
      }
    } catch {
      // Engine restarting (snapshot rescan) or transient network — next tick.
    }
  }

  async close(): Promise<void> {
    if (this.alertTimer) clearInterval(this.alertTimer);
    await this.alertStore.save(this.alertSeen, this.alertHistory);
    await Promise.all(
      [...this.connections.values()].map(async (c) => {
        await c.pool.end().catch(() => {});
        await c.tunnel?.close().catch(() => {});
      }),
    );
    this.connections.clear();
    await new Promise<void>((r) => this.server?.close(() => r()));
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname.startsWith("/api/dblab/")) return this.proxy(req, res, url);
    if (url.pathname === "/api/context") return this.context(res);
    if (url.pathname === "/api/replication") return this.replication(res);
    if (url.pathname === "/api/checkup") return this.checkup(res);
    if (url.pathname === "/api/snapshots/config" && req.method === "GET") {
      return this.getSnapshotConfig(res);
    }
    if (url.pathname === "/api/snapshots/config" && req.method === "PUT") {
      return this.putSnapshotConfig(req, res);
    }
    if (url.pathname === "/api/snapshots/create" && req.method === "POST") {
      return this.createSnapshot(res);
    }
    if (url.pathname === "/api/alerts" && req.method === "GET") return this.alerts(res);
    if (url.pathname === "/api/schema/sync" && req.method === "POST") return this.schemaSync(res);
    if (url.pathname === "/api/schema/drift" && req.method === "GET") {
      return this.schemaDriftRoute(res);
    }
    if (url.pathname === "/api/schema/config" && req.method === "PUT") {
      return this.putSchemaConfig(req, res);
    }
    if (url.pathname === "/api/alerts/slack" && req.method === "PUT") {
      return this.putSlackWebhook(req, res);
    }
    if (url.pathname === "/api/alerts/test" && req.method === "POST") {
      return this.testSlackWebhook(res);
    }
    if (url.pathname === "/api/query" && req.method === "POST") return this.query(req, res);
    if (url.pathname === "/api/branches" && req.method === "POST") return this.createBranch(req, res);
    const branchMatch = url.pathname.match(/^\/api\/branches\/([a-z0-9-]+)(\/uri|\/reset|\/tables|\/perf)?$/);
    if (branchMatch) {
      const [, name, action] = branchMatch;
      if (action === "/uri" && req.method === "GET") return this.branchUri(res, name!);
      if (action === "/tables" && req.method === "GET") return this.workflow(res, () => this.tables(name!));
      if (action === "/perf" && req.method === "GET") return this.workflow(res, () => this.perf(name!));
      if (action === "/reset" && req.method === "POST") {
        return this.workflow(res, async () => {
          await this.dropConnection(name!);
          const { clone, uri } = await resetBranch(this.session, name!);
          return { name, state: clone.status.code, port: clone.db?.port, uri };
        });
      }
      if (!action && req.method === "DELETE") {
        return this.workflow(res, async () => {
          await this.dropConnection(name!);
          await deleteBranch(this.session, name!);
          return { deleted: true };
        });
      }
    }
    return this.serveStatic(res, url.pathname);
  }

  private async context(res: ServerResponse): Promise<void> {
    let database: string | null = null;
    try {
      database = this.session.database();
    } catch {
      // leave null — the SPA shows a hint
    }
    if (this.cloneCapacity === undefined) {
      this.cloneCapacity = (await clonePortCapacity(this.session)) ?? null;
    }
    const repl = await this.resolveReplication();
    sendJson(res, 200, {
      env: this.session.config.envName ?? null,
      transport: this.session.transport,
      instanceId: this.session.instanceId ?? null,
      ssmPrefix: this.session.config.ssmPrefix,
      database,
      cloneCapacity: this.cloneCapacity,
      // With a streaming sync target configured, `main` is served live from it
      // rather than from a frozen clone.
      liveBranch: repl.subscriber ? LIVE_BRANCH : null,
    });
  }

  /** Session-level resolution (src/replication-urls.ts), cached per server. */
  private async resolveReplication(): Promise<ReplicationUrls> {
    if (this.replicationUrls === undefined) {
      this.replicationUrls = await resolveReplicationUrls(this.session, {
        // Plugin death (session limits) → drop the caches so the next request
        // respawns a fresh tunnel, mirroring connectionFor().
        onTunnelExit: () => {
          this.replicationUrls = undefined;
          void this.dropConnection(LIVE_BRANCH);
        },
      });
    }
    return this.replicationUrls;
  }

  private async replication(res: ServerResponse): Promise<void> {
    const { publisher, subscriber } = await this.resolveReplication();
    sendJson(res, 200, await fetchReplicationStatus(publisher ?? undefined, subscriber ?? undefined));
  }

  /**
   * The alert loop's result is the single source of truth — the chip and the
   * Alerts page must never disagree (a fresh probe here once raced the cached
   * loop and showed "2 warnings" over an "all clear" page).
   */
  private async currentCheckup(): Promise<Checkup> {
    if (this.lastCheckup && Date.now() - Date.parse(this.lastCheckup.measuredAt) < 90_000) {
      return this.lastCheckup;
    }
    const checkup = await runCheckup(this.session, {
      replicationUrls: await this.resolveReplication(),
    });
    this.lastCheckup = checkup;
    return checkup;
  }

  private async checkup(res: ServerResponse): Promise<void> {
    return this.workflow(res, () => this.currentCheckup());
  }

  /** SSM access on any transport (hosted console runs direct + region env). */
  private snapshotFacade(): SsmFacade {
    if (!this.ssmFacade) {
      this.ssmFacade = snapshotSsm(this.session.config, this.session.ssm);
    }
    return this.ssmFacade;
  }

  private async getSnapshotConfig(res: ServerResponse): Promise<void> {
    return this.workflow(res, async () => ({
      config: await getScheduleConfig(this.snapshotFacade(), this.session.config.ssmPrefix),
    }));
  }

  private async putSnapshotConfig(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await readBody(req);
    return this.workflow(res, async () => {
      const config = validateScheduleConfig(JSON.parse(raw || "{}"));
      await setScheduleConfig(this.snapshotFacade(), this.session.config.ssmPrefix, config);
      return { config };
    });
  }

  /**
   * Fire-and-return: oauth2-proxy cuts long-held upstream requests (~30s), so
   * anything daemon-paced answers immediately and the SPA polls for the
   * outcome instead.
   */
  private async createSnapshot(res: ServerResponse): Promise<void> {
    return this.workflow(res, async () => {
      await requestSnapshot(this.snapshotFacade(), this.session.config.ssmPrefix);
      return { started: true };
    });
  }

  /** Current findings + the event feed since this console started. */
  private async alerts(res: ServerResponse): Promise<void> {
    return this.workflow(res, async () => ({
      current: await this.currentCheckup(),
      history: [...this.alertHistory].reverse(),
      slack: { configured: Boolean(await this.slackWebhook()) },
      schema: {
        autoSync:
          (await getSchemaConfig(this.snapshotFacade(), this.session.config.ssmPrefix))?.autoSync ??
          false,
      },
    }));
  }

  /** Fire the daemon's full reconcile; the SPA polls /api/schema/drift. */
  private async schemaSync(res: ServerResponse): Promise<void> {
    return this.workflow(res, async () => {
      await requestSchemaSync(this.snapshotFacade(), this.session.config.ssmPrefix);
      return { started: true };
    });
  }

  /** Live drift readout (fast — two fingerprint queries). */
  private async schemaDriftRoute(res: ServerResponse): Promise<void> {
    return this.workflow(res, async () => {
      const drift = await schemaDrift(await this.resolveReplication());
      return {
        ...drift,
        inSync: drift.missing.length + drift.orphaned.length + drift.mismatched.length === 0,
      };
    });
  }

  private async putSchemaConfig(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await readBody(req);
    return this.workflow(res, async () => {
      const config = validateSchemaConfig(JSON.parse(raw || "{}"));
      await setSchemaConfig(this.snapshotFacade(), this.session.config.ssmPrefix, config);
      return { config };
    });
  }

  private async putSlackWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await readBody(req);
    return this.workflow(res, async () => {
      const { url } = JSON.parse(raw || "{}") as { url?: string };
      const trimmed = (url ?? "").trim();
      if (trimmed && !/^https:\/\//.test(trimmed)) {
        throw new TenDBError("webhook must be an https:// URL");
      }
      await this.snapshotFacade().putParameter(
        `${this.session.config.ssmPrefix}/alerts/slack-webhook`,
        trimmed || "none",
        true,
      );
      return { configured: Boolean(trimmed) };
    });
  }

  private async testSlackWebhook(res: ServerResponse): Promise<void> {
    return this.workflow(res, async () => {
      const webhook = await this.slackWebhook();
      if (!webhook) throw new TenDBError("no Slack webhook configured");
      const ok = await postToSlack(
        webhook,
        {
          at: new Date().toISOString(),
          type: "alert",
          code: "engine-unreachable",
          finding: {
            code: "engine-unreachable",
            severity: "warning",
            message: "test message from the tendb console — alerts are wired up",
          },
        },
        fetch,
        { consoleUrl: await this.consoleUrl() },
      );
      if (!ok) throw new TenDBError("Slack rejected the test message");
      return { sent: true };
    });
  }

  /** Run a workflow, mapping typed errors to HTTP + the CLI exit-code taxonomy. */
  private async workflow(res: ServerResponse, fn: () => Promise<unknown>): Promise<void> {
    try {
      const result = await fn();
      sendJson(res, 200, result);
    } catch (err) {
      const e = err as TenDBError;
      const http = e instanceof TenDBError && e.exitCode === 3 ? 404 : e instanceof TenDBError && e.exitCode === 42 ? 409 : 500;
      sendJson(res, http, { error: { message: e.message, hint: e instanceof TenDBError ? e.hint : undefined } });
    }
  }

  private async createBranch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await readBody(req);
    let body: { name?: string; from?: string; fresh?: boolean };
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      return sendJson(res, 400, { error: { message: "invalid JSON body" } });
    }
    if (!body.name || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(body.name)) {
      return sendJson(res, 400, { error: { message: "body must be {name} matching [a-z0-9][a-z0-9-]*" } });
    }
    return this.workflow(res, async () => {
      if (body.fresh) {
        await createSnapshotNow(
          this.session.client,
          this.snapshotFacade(),
          this.session.config.ssmPrefix,
        );
      }
      const { clone, uri } = await ensureBranch(this.session, body.name!, { from: body.from });
      return { name: body.name, state: clone.status.code, port: clone.db?.port, uri };
    });
  }

  private async dropConnection(branch: string): Promise<void> {
    const conn = this.connections.get(branch);
    if (!conn) return;
    this.connections.delete(branch);
    await conn.pool.end().catch(() => {});
    await conn.tunnel?.close().catch(() => {});
  }

  /**
   * Schema browser payload: every user table with sizes, estimated rows, and
   * its columns (type, nullability, default, PK membership).
   */
  private async tables(branch: string): Promise<unknown> {
    const conn = await this.connectionFor(branch);
    const tables = await conn.pool.query(`
      select n.nspname as schema, c.relname as name,
             greatest(c.reltuples, 0)::bigint as est_rows,
             pg_total_relation_size(c.oid)::bigint as total_bytes,
             pg_indexes_size(c.oid)::bigint as index_bytes
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r', 'p')
        and n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
      order by pg_total_relation_size(c.oid) desc, c.relname`);
    const columns = await conn.pool.query(`
      select n.nspname as schema, c.relname as table, a.attname as name,
             format_type(a.atttypid, a.atttypmod) as type,
             not a.attnotnull as nullable,
             pg_get_expr(d.adbin, d.adrelid) as default,
             coalesce(a.attnum = any(i.indkey), false) as is_pk
      from pg_attribute a
      join pg_class c on c.oid = a.attrelid
      join pg_namespace n on n.oid = c.relnamespace
      left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      left join pg_index i on i.indrelid = c.oid and i.indisprimary
      where c.relkind in ('r', 'p') and a.attnum > 0 and not a.attisdropped
        and n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
      order by n.nspname, c.relname, a.attnum`);
    const byTable = new Map<string, unknown[]>();
    for (const col of columns.rows) {
      const key = `${col.schema}.${col.table}`;
      if (!byTable.has(key)) byTable.set(key, []);
      byTable.get(key)!.push({
        name: col.name,
        type: col.type,
        nullable: col.nullable,
        default: col.default,
        isPk: col.is_pk,
      });
    }
    return {
      tables: tables.rows.map((t) => ({
        schema: t.schema,
        name: t.name,
        estRows: Number(t.est_rows),
        totalBytes: Number(t.total_bytes),
        indexBytes: Number(t.index_bytes),
        columns: byTable.get(`${t.schema}.${t.name}`) ?? [],
      })),
    };
  }

  /**
   * Performance snapshot of one clone. Counters are the CLONE's own (stats
   * reset when a clone starts) — which is the point: exercise a workload on a
   * branch, read its footprint here. pg_stat_statements is created on demand
   * (clones are writable); when unavailable, topQueries is null with a reason.
   */
  private async perf(branch: string): Promise<unknown> {
    const conn = await this.connectionFor(branch);
    const [size, cache, activity, tableStats] = await Promise.all([
      conn.pool.query(`select pg_database_size(current_database())::bigint as bytes`),
      conn.pool.query(`
        select coalesce(sum(blks_hit), 0)::bigint as hits, coalesce(sum(blks_read), 0)::bigint as reads
        from pg_stat_database where datname = current_database()`),
      conn.pool.query(`
        select coalesce(state, 'unknown') as state, count(*)::int as count
        from pg_stat_activity where datname = current_database() group by 1`),
      conn.pool.query(`
        select schemaname as schema, relname as name,
               seq_scan::bigint as seq_scans, coalesce(idx_scan, 0)::bigint as idx_scans,
               n_live_tup::bigint as live_rows, n_dead_tup::bigint as dead_rows,
               last_autovacuum, last_autoanalyze
        from pg_stat_user_tables order by n_live_tup desc limit 50`),
    ]);

    let topQueries: unknown = null;
    let topQueriesError: string | null = null;
    try {
      await conn.pool.query(`create extension if not exists pg_stat_statements`);
      const top = await conn.pool.query(`
        select left(query, 300) as query, calls::bigint as calls,
               round(total_exec_time::numeric, 1) as total_ms,
               round(mean_exec_time::numeric, 2) as mean_ms,
               rows::bigint as rows
        from pg_stat_statements
        where dbid = (select oid from pg_database where datname = current_database())
          and query not like '%pg_stat_statements%'
        order by total_exec_time desc limit 15`);
      topQueries = top.rows.map((q) => ({
        query: q.query,
        calls: Number(q.calls),
        totalMs: Number(q.total_ms),
        meanMs: Number(q.mean_ms),
        rows: Number(q.rows),
      }));
    } catch (err) {
      topQueriesError = (err as Error).message;
    }

    const hits = Number(cache.rows[0]?.hits ?? 0);
    const reads = Number(cache.rows[0]?.reads ?? 0);
    return {
      dbBytes: Number(size.rows[0]?.bytes ?? 0),
      cacheHitRatio: hits + reads > 0 ? hits / (hits + reads) : null,
      activity: activity.rows,
      tableStats: tableStats.rows.map((t) => ({
        schema: t.schema,
        name: t.name,
        seqScans: Number(t.seq_scans),
        idxScans: Number(t.idx_scans),
        liveRows: Number(t.live_rows),
        deadRows: Number(t.dead_rows),
        lastAutovacuum: t.last_autovacuum,
        lastAutoanalyze: t.last_autoanalyze,
      })),
      topQueries,
      topQueriesError,
    };
  }

  private async proxy(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const path = url.pathname.slice("/api/dblab".length) + url.search;
    const body = ["GET", "HEAD"].includes(req.method ?? "GET") ? undefined : await readBody(req);
    const upstream = await fetch(`${this.session.apiBaseUrl}${path}`, {
      method: req.method,
      headers: {
        "Verification-Token": this.session.token,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body,
    });
    const text = await upstream.text();
    res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
    res.end(text);
  }

  private async branchUri(res: ServerResponse, name: string): Promise<void> {
    if (name === LIVE_BRANCH) {
      const { subscriber, subscriberRemote } = await this.resolveReplication();
      if (subscriber && subscriberRemote) {
        let port: number | null = null;
        try {
          port = Number(new URL(subscriberRemote).port || 5432);
        } catch {
          // leave null
        }
        return sendJson(res, 200, {
          uri: subscriberRemote,
          localUri: subscriber !== subscriberRemote ? subscriber : null,
          port,
        });
      }
    }
    try {
      const { clone, uri } = await getBranchClone(this.session, name);
      const conn = this.connections.get(name);
      sendJson(res, 200, {
        uri,
        localUri: conn?.tunnel ? localizeUri(uri, conn.tunnel.localPort) : null,
        port: clone.db?.port ?? null,
      });
    } catch (err) {
      const code = err instanceof TenDBError && err.exitCode === 3 ? 404 : 500;
      sendJson(res, code, { error: { message: (err as Error).message } });
    }
  }

  private async connectionFor(branch: string): Promise<BranchConnection> {
    const cached = this.connections.get(branch);
    if (cached) return cached;

    // Live main: queries run against the streaming sync target, read-only —
    // it is a logical-replication subscriber, and local writes would race the
    // stream. Writes belong on the source (Aurora) or on a real branch.
    if (branch === LIVE_BRANCH) {
      const { subscriber } = await this.resolveReplication();
      if (subscriber) {
        const pool = new pg.Pool({
          connectionString: subscriber,
          max: 2,
          statement_timeout: QUERY_TIMEOUT_MS,
          connectionTimeoutMillis: 10_000,
          options: "-c default_transaction_read_only=on",
        });
        const conn: BranchConnection = { tunnel: null, pool };
        this.connections.set(branch, conn);
        return conn;
      }
    }

    const { clone, uri } = await getBranchClone(this.session, branch);
    let connString = uri;
    let tunnel: Tunnel | null = null;
    if (this.session.transport === "ssm") {
      tunnel = await this.session.openClonePort(Number(clone.db?.port));
      connString = localizeUri(uri, tunnel.localPort);
      // If the plugin dies (session limits), drop the cache entry so the next
      // query respawns a fresh tunnel.
      tunnel.onExit.then(() => {
        const current = this.connections.get(branch);
        if (current?.tunnel === tunnel) {
          this.connections.delete(branch);
          current.pool.end().catch(() => {});
        }
      });
    }
    const pool = new pg.Pool({
      connectionString: connString,
      max: 2,
      statement_timeout: QUERY_TIMEOUT_MS,
      connectionTimeoutMillis: 10_000,
    });
    const conn: BranchConnection = { tunnel, pool };
    this.connections.set(branch, conn);
    return conn;
  }

  private async query(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await readBody(req);
    let parsed: { branch?: string; sql?: string };
    try {
      parsed = JSON.parse(raw || "{}");
    } catch {
      return sendJson(res, 400, { error: { message: "invalid JSON body" } });
    }
    const { branch, sql } = parsed;
    if (!branch || !sql || !/^[a-z0-9-]+$/.test(branch)) {
      return sendJson(res, 400, { error: { message: "body must be {branch, sql}" } });
    }
    const started = Date.now();
    try {
      const conn = await this.connectionFor(branch);
      const result = await conn.pool.query({ text: sql, rowMode: "array" });
      const rows = (result.rows ?? []).slice(0, ROW_CAP);
      sendJson(res, 200, {
        columns: (result.fields ?? []).map((f) => f.name),
        rows,
        rowCount: result.rowCount ?? rows.length,
        truncated: (result.rows?.length ?? 0) > ROW_CAP,
        durationMs: Date.now() - started,
        command: result.command,
      });
    } catch (err) {
      const e = err as Error & { position?: string; code?: string };
      sendJson(res, 200, {
        error: { message: e.message, position: e.position ?? null, code: e.code ?? null },
        durationMs: Date.now() - started,
      });
    }
  }

  private async serveStatic(res: ServerResponse, pathname: string): Promise<void> {
    if (!existsSync(this.staticDir)) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("console assets missing — run `pnpm build` in tendb/cli first");
      return;
    }
    const rel = pathname === "/" ? "index.html" : pathname.slice(1);
    let file = normalize(join(this.staticDir, rel));
    if (!file.startsWith(normalize(this.staticDir)) || !existsSync(file)) {
      file = join(this.staticDir, "index.html"); // SPA fallback
    }
    try {
      const content = await readFile(file);
      res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
      res.end(content);
    } catch {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    }
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_CAP) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
