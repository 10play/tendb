import pg from "pg";

/**
 * Upstream replication status for the console's sync view: the hop BEFORE the
 * engine (e.g. Aurora → Neon logical replication, where Neon is the engine's
 * dump source). The publisher and subscriber are queried independently so one
 * side being down degrades that side only.
 */

const QUERY_TIMEOUT_MS = 5_000;

export interface PublisherPeer {
  applicationName: string | null;
  clientAddr: string | null;
  state: string | null;
  writeLagMs: number | null;
  flushLagMs: number | null;
  replayLagMs: number | null;
}

export interface PublisherSlot {
  name: string;
  active: boolean;
  /** WAL bytes the subscriber has not yet confirmed (0 = caught up). */
  lagBytes: number | null;
  /**
   * WAL bytes the publisher keeps on disk for this slot (restart_lsn → head).
   * Grows without bound while a slot is stalled — the disk-pressure signal,
   * distinct from lagBytes which resets as soon as the subscriber confirms.
   */
  walRetainedBytes: number | null;
  /**
   * reserved → extended → unreserved → lost. `unreserved` is a checkpoint away
   * from invalidation; `lost` means the WAL gap is permanent and the sync
   * target can only be recovered by a full reseed.
   */
  walStatus: string | null;
}

export interface PublisherStatus {
  connected: boolean;
  error?: string;
  currentLsn?: string;
  slots?: PublisherSlot[];
  peers?: PublisherPeer[];
  /** table name → column fingerprint; present when schema collection was asked for. */
  tables?: Record<string, string>;
  /** table name → index fingerprint (constraint-backed indexes excluded). */
  indexes?: Record<string, string>;
}

export interface SubscriberSubscription {
  name: string;
  enabled: boolean;
  receivedLsn: string | null;
  lastMessageAt: string | null;
  /** Seconds since the last message from the publisher (staleness, not lag). */
  secondsSinceLastMessage: number | null;
  applyErrors: number;
  syncErrors: number;
}

export interface SubscriberStatus {
  connected: boolean;
  error?: string;
  subscriptions?: SubscriberSubscription[];
  /** table name → column fingerprint; present when schema collection was asked for. */
  tables?: Record<string, string>;
  /** table name → index fingerprint (constraint-backed indexes excluded). */
  indexes?: Record<string, string>;
}

/**
 * Schema drift between publisher and subscriber. Logical replication carries
 * no DDL, so drift is SILENT until rows hit a missing relation — comparing
 * column fingerprints surfaces it before (or without) a stream break.
 */
export interface SchemaDiff {
  /** On the publisher, absent downstream — first write will pause the stream. */
  missing: string[];
  /** Only on the subscriber (dropped upstream) — collides if ever recreated. */
  orphaned: string[];
  /** Same table, different columns/types. */
  mismatched: string[];
  /** Same table and columns, different (non-constraint) indexes. */
  indexesDiffer: string[];
}

export function diffSchemas(
  publisher: Record<string, string>,
  subscriber: Record<string, string>,
  publisherIndexes: Record<string, string> = {},
  subscriberIndexes: Record<string, string> = {},
): SchemaDiff {
  const missing = Object.keys(publisher).filter((t) => !(t in subscriber)).sort();
  const orphaned = Object.keys(subscriber).filter((t) => !(t in publisher)).sort();
  const mismatched = Object.keys(publisher)
    .filter((t) => t in subscriber && publisher[t] !== subscriber[t])
    .sort();
  // Only tables present on both sides — missing/orphaned already cover the
  // rest, and a table with no rows in the index map simply has no indexes.
  const indexesDiffer = Object.keys(publisher)
    .filter((t) => t in subscriber)
    .filter((t) => (publisherIndexes[t] ?? "") !== (subscriberIndexes[t] ?? ""))
    .sort();
  return { missing, orphaned, mismatched, indexesDiffer };
}

const SCHEMA_FINGERPRINT_SQL = `
  select table_name,
         md5(string_agg(column_name || ':' || data_type || ':' || is_nullable,
                        ',' order by ordinal_position)) as fp
  from information_schema.columns
  where table_schema = 'public'
  group by table_name`;

// Constraint-backed indexes (PK/UNIQUE) are excluded to mirror what the
// snapshotd daemon can heal — a later-added PK still surfaces as column
// drift via its NOT NULL.
const INDEX_FINGERPRINT_SQL = `
  select i.tablename as table_name,
         md5(string_agg(i.indexdef, ',' order by i.indexname)) as fp
  from pg_indexes i
  where i.schemaname = 'public'
    and not exists (
      select 1 from pg_constraint con
      join pg_class ic on ic.oid = con.conindid
      join pg_namespace nsp on nsp.oid = ic.relnamespace
      where ic.relname = i.indexname and nsp.nspname = i.schemaname)
  group by i.tablename`;

export interface ReplicationStatus {
  configured: boolean;
  publisher?: PublisherStatus;
  subscriber?: SubscriberStatus;
  measuredAt: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function normalizePublisher(
  lsnRow: any,
  slotRows: any[],
  peerRows: any[],
): PublisherStatus {
  return {
    connected: true,
    currentLsn: lsnRow?.lsn ?? undefined,
    slots: slotRows.map((s) => ({
      name: String(s.slot_name),
      active: Boolean(s.active),
      lagBytes: s.lag_bytes === null || s.lag_bytes === undefined ? null : Number(s.lag_bytes),
      walRetainedBytes:
        s.wal_retained_bytes === null || s.wal_retained_bytes === undefined
          ? null
          : Number(s.wal_retained_bytes),
      walStatus: s.wal_status === null || s.wal_status === undefined ? null : String(s.wal_status),
    })),
    peers: peerRows.map((p) => ({
      applicationName: p.application_name ?? null,
      clientAddr: p.client_addr ?? null,
      state: p.state ?? null,
      writeLagMs: p.write_lag_ms === null || p.write_lag_ms === undefined ? null : Number(p.write_lag_ms),
      flushLagMs: p.flush_lag_ms === null || p.flush_lag_ms === undefined ? null : Number(p.flush_lag_ms),
      replayLagMs: p.replay_lag_ms === null || p.replay_lag_ms === undefined ? null : Number(p.replay_lag_ms),
    })),
  };
}

export function normalizeSubscriber(subRows: any[]): SubscriberStatus {
  return {
    connected: true,
    subscriptions: subRows.map((s) => ({
      name: String(s.subname),
      enabled: Boolean(s.subenabled),
      receivedLsn: s.received_lsn ?? null,
      lastMessageAt:
        s.last_msg_receipt_time instanceof Date
          ? s.last_msg_receipt_time.toISOString()
          : (s.last_msg_receipt_time ?? null),
      secondsSinceLastMessage:
        s.seconds_since_last_message === null || s.seconds_since_last_message === undefined
          ? null
          : Number(s.seconds_since_last_message),
      applyErrors: Number(s.apply_error_count ?? 0),
      syncErrors: Number(s.sync_error_count ?? 0),
    })),
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * TLS is verified against Node's trust store. Neon chains to a public CA and
 * just works; RDS/Aurora certs chain to the RDS CA, so point
 * NODE_EXTRA_CA_CERTS at the RDS global bundle (the aurora-source example's
 * README and the hosted-console init both do this). A missing CA fails closed
 * with a clear error in the status payload rather than connecting unverified.
 */
function poolFor(url: string): pg.Pool {
  return new pg.Pool({
    connectionString: url,
    max: 1,
    statement_timeout: QUERY_TIMEOUT_MS,
    connectionTimeoutMillis: 10_000,
    ssl: /sslmode=(require|prefer|verify)/.test(url) ? { rejectUnauthorized: true } : undefined,
  });
}

async function queryPublisher(url: string, includeSchema: boolean): Promise<PublisherStatus> {
  const pool = poolFor(url);
  try {
    const [lsn, slots, peers, schema, indexes] = await Promise.all([
      pool.query(`select pg_current_wal_lsn()::text as lsn`),
      pool.query(`
        select slot_name, active, wal_status,
               pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn)::bigint as lag_bytes,
               pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)::bigint as wal_retained_bytes
        from pg_replication_slots
        where slot_type = 'logical'`),
      pool.query(`
        select application_name, client_addr::text as client_addr, state,
               (extract(epoch from write_lag) * 1000)::float8 as write_lag_ms,
               (extract(epoch from flush_lag) * 1000)::float8 as flush_lag_ms,
               (extract(epoch from replay_lag) * 1000)::float8 as replay_lag_ms
        from pg_stat_replication`),
      includeSchema ? pool.query(SCHEMA_FINGERPRINT_SQL) : Promise.resolve(null),
      includeSchema ? pool.query(INDEX_FINGERPRINT_SQL) : Promise.resolve(null),
    ]);
    const status = normalizePublisher(lsn.rows[0], slots.rows, peers.rows);
    if (schema) status.tables = tableMap(schema.rows);
    if (indexes) status.indexes = tableMap(indexes.rows);
    return status;
  } catch (err) {
    return { connected: false, error: (err as Error).message };
  } finally {
    await pool.end().catch(() => {});
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function tableMap(rows: any[]): Record<string, string> {
  return Object.fromEntries(rows.map((r) => [String(r.table_name), String(r.fp)]));
}
/* eslint-enable @typescript-eslint/no-explicit-any */

async function querySubscriber(url: string, includeSchema: boolean): Promise<SubscriberStatus> {
  const pool = poolFor(url);
  try {
    // Columns listed explicitly: pg_subscription.subconninfo is superuser-only
    // and a bare * would fail. stat.relid is null on the main apply worker.
    const [subs, schema, indexes] = await Promise.all([
      pool.query(`
      select sub.subname, sub.subenabled,
             stat.received_lsn::text as received_lsn,
             stat.last_msg_receipt_time,
             extract(epoch from (now() - stat.last_msg_receipt_time))::float8
               as seconds_since_last_message,
             coalesce(errs.apply_error_count, 0)::bigint as apply_error_count,
             coalesce(errs.sync_error_count, 0)::bigint as sync_error_count
      from pg_subscription sub
      left join pg_stat_subscription stat
        on stat.subid = sub.oid and stat.relid is null
      left join pg_stat_subscription_stats errs on errs.subid = sub.oid`),
      includeSchema ? pool.query(SCHEMA_FINGERPRINT_SQL) : Promise.resolve(null),
      includeSchema ? pool.query(INDEX_FINGERPRINT_SQL) : Promise.resolve(null),
    ]);
    const status = normalizeSubscriber(subs.rows);
    if (schema) status.tables = tableMap(schema.rows);
    if (indexes) status.indexes = tableMap(indexes.rows);
    return status;
  } catch (err) {
    return { connected: false, error: (err as Error).message };
  } finally {
    await pool.end().catch(() => {});
  }
}

export async function fetchReplicationStatus(
  publisherUrl: string | undefined,
  subscriberUrl: string | undefined,
  opts: { includeSchema?: boolean } = {},
): Promise<ReplicationStatus> {
  if (!publisherUrl && !subscriberUrl) {
    return { configured: false, measuredAt: new Date().toISOString() };
  }
  const includeSchema = opts.includeSchema ?? false;
  const [publisher, subscriber] = await Promise.all([
    publisherUrl ? queryPublisher(publisherUrl, includeSchema) : Promise.resolve(undefined),
    subscriberUrl ? querySubscriber(subscriberUrl, includeSchema) : Promise.resolve(undefined),
  ]);
  return { configured: true, publisher, subscriber, measuredAt: new Date().toISOString() };
}
