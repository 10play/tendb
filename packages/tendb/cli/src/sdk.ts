/**
 * @10play/tendb — programmatic SDK.
 *
 * The same session/workflow internals the CLI uses, behind a typed client:
 * branch lifecycle, migration rehearsal, replication status, and a checkup /
 * watch surface designed so alert destinations (Slack, PagerDuty, anything
 * with a webhook) connect later without redesign.
 *
 *   import { createClient, webhookSink } from "@10play/tendb";
 *   const client = createClient();               // tendb.json discovery
 *   const result = await client.migrate({ command: ["npx", "prisma", "migrate", "deploy"] });
 *   const watcher = client.watch({ ...webhookSink("https://hooks.example/pg") });
 */
import { resolveConfig, type ConfigOverrides } from "./config.js";
import { openSession, clonePortCapacity, type ApiSession } from "./context.js";
import type { Branch, Clone, InstanceStatus } from "./dblab/types.js";
import { deleteBranch, ensureBranch, getBranchClone, resetBranch } from "./dblab/workflows.js";
import { execOnBranch, migrate, openBranchUrl, type BranchUrl, type ExecResult, type MigrateOptions, type MigrateResult } from "./migrate.js";
import { fetchReplicationStatus, type ReplicationStatus } from "./console/replication.js";
import { resolveReplicationUrls, type ReplicationUrls } from "./replication-urls.js";
import {
  debounceUnreachable,
  diffFindings,
  evaluateCheckup,
  runCheckup,
  DEFAULT_THRESHOLDS,
  type Checkup,
  type CheckupThresholds,
  type Finding,
  type FindingCode,
} from "./monitor/checkup.js";
import { postToSlack, slackPayload, type AlertEvent } from "./monitor/slack.js";
import {
  createSnapshotNow,
  getScheduleConfig,
  poolSnapshots,
  setScheduleConfig,
  snapshotSsm,
  type SnapshotScheduleConfig,
} from "./snapshots.js";
import {
  forceSchemaSync,
  getSchemaConfig,
  schemaDrift,
  setSchemaConfig,
  type SchemaSyncConfig,
} from "./schema-sync.js";
import type { SchemaDiff } from "./console/replication.js";
import type { Snapshot } from "./dblab/types.js";

export type ClientOptions = Omit<ConfigOverrides, "env"> & {
  /** Named environment from tendb.json's `environments` block. */
  environment?: string;
  configPath?: string;
  cwd?: string;
};

export interface BranchSummary {
  name: string;
  parent: string | null;
  dataStateAt: string | null;
  clone: { state: string; port: number | null } | null;
}

export interface BranchHandle {
  name: string;
  state: string;
  port: number | null;
  /** Canonical URI on the engine host (in-VPC form). */
  uri: string;
}

export interface StatusSummary {
  healthy: boolean;
  instance: InstanceStatus | undefined;
  cloneCapacity: number | null;
}

export interface WatchOptions {
  intervalMs?: number;
  thresholds?: Partial<CheckupThresholds>;
  /** New finding, or an existing one escalating to critical. */
  onAlert?: (finding: Finding) => void;
  /** A previously-alerted finding cleared. */
  onRecover?: (code: FindingCode) => void;
  /** Poll failure (network, auth). Default: ignored — next tick retries. */
  onError?: (error: unknown) => void;
}

export interface Watcher {
  stop(): void;
}

export class TenDBClient {
  private sessionPromise: Promise<ApiSession> | undefined;
  private replicationUrls: ReplicationUrls | undefined;

  constructor(private readonly options: ClientOptions = {}) {}

  private session(): Promise<ApiSession> {
    if (!this.sessionPromise) {
      const { environment, configPath, cwd, ...flags } = this.options;
      this.sessionPromise = openSession(
        resolveConfig({ flags: { ...flags, env: environment }, configPath, cwd }),
      );
    }
    return this.sessionPromise;
  }

  private async replicationEndpoints(): Promise<ReplicationUrls> {
    if (!this.replicationUrls) {
      this.replicationUrls = await resolveReplicationUrls(await this.session(), {
        onTunnelExit: () => {
          this.replicationUrls = undefined;
        },
      });
    }
    return this.replicationUrls;
  }

  readonly branches = {
    list: async (): Promise<BranchSummary[]> => {
      const session = await this.session();
      const [branches, status] = await Promise.all([
        session.client.listBranches(),
        session.client.status(),
      ]);
      const clones = new Map<string, Clone>();
      for (const clone of status.cloning?.clones ?? []) {
        if (clone.branch) clones.set(clone.branch, clone);
      }
      return branches.map((branch: Branch) => {
        const clone = clones.get(branch.name);
        return {
          name: branch.name,
          parent: branch.parent ?? null,
          dataStateAt: branch.dataStateAt ?? null,
          clone: clone
            ? { state: clone.status.code, port: clone.db?.port ? Number(clone.db.port) : null }
            : null,
        };
      });
    },

    create: async (
      name: string,
      opts: { from?: string; fresh?: boolean } = {},
    ): Promise<BranchHandle> => {
      const session = await this.session();
      // fresh = snapshot the streaming sync target first, so the branch is
      // "main as of now" instead of "as of the last snapshot".
      if (opts.fresh) {
        await createSnapshotNow(session.client, snapshotSsm(session.config, session.ssm), session.config.ssmPrefix);
      }
      const { clone, uri } = await ensureBranch(session, name, { from: opts.from });
      return handleFrom(name, clone, uri);
    },

    get: async (name: string): Promise<BranchHandle> => {
      const { clone, uri } = await getBranchClone(await this.session(), name);
      return handleFrom(name, clone, uri);
    },

    reset: async (name: string): Promise<BranchHandle> => {
      const { clone, uri } = await resetBranch(await this.session(), name);
      return handleFrom(name, clone, uri);
    },

    delete: async (name: string): Promise<void> => {
      await deleteBranch(await this.session(), name);
    },
  };

  readonly snapshots = {
    list: async (): Promise<Snapshot[]> => {
      const session = await this.session();
      return poolSnapshots(await session.client.listSnapshots());
    },

    /** O(1) ZFS snapshot of the streaming sync target (~10 s wall). */
    create: async (opts: { timeoutMs?: number } = {}): Promise<Snapshot> => {
      const session = await this.session();
      return createSnapshotNow(
        session.client,
        snapshotSsm(session.config, session.ssm),
        session.config.ssmPrefix,
        opts,
      );
    },

    getConfig: async (): Promise<SnapshotScheduleConfig | null> => {
      const session = await this.session();
      return getScheduleConfig(snapshotSsm(session.config, session.ssm), session.config.ssmPrefix);
    },

    setConfig: async (config: SnapshotScheduleConfig): Promise<void> => {
      const session = await this.session();
      await setScheduleConfig(snapshotSsm(session.config, session.ssm), session.config.ssmPrefix, config);
    },
  };

  readonly schema = {
    /** Drift between publisher and sync target (all lists empty = in sync). */
    diff: async (): Promise<SchemaDiff> => {
      return schemaDrift(await this.replicationEndpoints());
    },

    /** Full reconcile via the engine-host daemon; resolves missing AND orphaned tables. */
    sync: async (opts: { timeoutMs?: number } = {}): Promise<SchemaDiff> => {
      const session = await this.session();
      return forceSchemaSync(
        snapshotSsm(session.config, session.ssm),
        session.config.ssmPrefix,
        await this.replicationEndpoints(),
        opts,
      );
    },

    getConfig: async (): Promise<SchemaSyncConfig | null> => {
      const session = await this.session();
      return getSchemaConfig(snapshotSsm(session.config, session.ssm), session.config.ssmPrefix);
    },

    /** autoSync: the daemon heals additive drift on its own (~1 min cadence). */
    setConfig: async (config: SchemaSyncConfig): Promise<void> => {
      const session = await this.session();
      await setSchemaConfig(snapshotSsm(session.config, session.ssm), session.config.ssmPrefix, config);
    },
  };

  async status(): Promise<StatusSummary> {
    const session = await this.session();
    const healthy = await session.client.healthz();
    const instance = healthy ? await session.client.status().catch(() => undefined) : undefined;
    const cloneCapacity = (await clonePortCapacity(session).catch(() => undefined)) ?? null;
    return { healthy, instance, cloneCapacity };
  }

  async replication(): Promise<ReplicationStatus> {
    const { publisher, subscriber } = await this.replicationEndpoints();
    return fetchReplicationStatus(publisher ?? undefined, subscriber ?? undefined);
  }

  async connectionString(branch: string): Promise<string> {
    const { uri } = await getBranchClone(await this.session(), branch);
    return uri;
  }

  /** Dial-ready URL (SSM branches get a tunnel; close() it when done). */
  async branchUrl(branch: string): Promise<BranchUrl> {
    return openBranchUrl(await this.session(), branch);
  }

  /** Run a command with DATABASE_URL pointed at the branch. */
  async exec(branch: string, argv: string[], env?: Record<string, string>): Promise<ExecResult> {
    return execOnBranch(await this.session(), branch, argv, { env });
  }

  /** Ephemeral-branch pattern: ensure → fn → delete (unless keep). */
  async withBranch<T>(
    name: string,
    fn: (branch: BranchHandle & { url: string }) => Promise<T>,
    opts: { from?: string; keep?: boolean } = {},
  ): Promise<T> {
    const session = await this.session();
    const { clone, uri } = await ensureBranch(session, name, { from: opts.from });
    const opened = await openBranchUrl(session, name);
    try {
      return await fn({ ...handleFrom(name, clone, uri), url: opened.url });
    } finally {
      await opened.close().catch(() => {});
      if (!opts.keep) await deleteBranch(session, name).catch(() => {});
    }
  }

  /** Rehearse a migration on production-shaped data. See MigrateOptions. */
  async migrate(opts: MigrateOptions): Promise<MigrateResult> {
    const session = await this.session();
    if (opts.fresh) {
      await createSnapshotNow(session.client, snapshotSsm(session.config, session.ssm), session.config.ssmPrefix);
    }
    return migrate(session, opts);
  }

  async checkup(thresholds?: Partial<CheckupThresholds>): Promise<Checkup> {
    return runCheckup(await this.session(), {
      thresholds,
      replicationUrls: await this.replicationEndpoints(),
    });
  }

  /**
   * Poll checkup and emit transitions: onAlert for a new finding (or a warning
   * escalating to critical), onRecover when a finding clears.
   */
  watch(opts: WatchOptions = {}): Watcher {
    const intervalMs = opts.intervalMs ?? 60_000;
    const seen = new Map<FindingCode, Finding["severity"]>();
    // Snapshot rescans restart the engine ~2s; one missed probe is not an
    // outage. engine-unreachable must hold for two consecutive ticks.
    const unreachable = { streak: 0 };
    let stopped = false;

    const tick = async () => {
      try {
        const { findings } = debounceUnreachable(await this.checkup(opts.thresholds), unreachable);
        if (stopped) return;
        const { alerts, recovers } = diffFindings(seen, findings);
        for (const finding of alerts) opts.onAlert?.(finding);
        for (const code of recovers) opts.onRecover?.(code);
      } catch (error) {
        opts.onError?.(error);
      }
    };

    void tick();
    const timer = setInterval(() => void tick(), intervalMs);
    return {
      stop: () => {
        stopped = true;
        clearInterval(timer);
      },
    };
  }

  async close(): Promise<void> {
    if (!this.sessionPromise) return;
    const session = await this.sessionPromise;
    this.sessionPromise = undefined;
    this.replicationUrls = undefined;
    await session.close();
  }
}

function handleFrom(name: string, clone: Clone, uri: string): BranchHandle {
  return {
    name,
    state: clone.status.code,
    port: clone.db?.port ? Number(clone.db.port) : null,
    uri,
  };
}

export function createClient(options: ClientOptions = {}): TenDBClient {
  return new TenDBClient(options);
}

/**
 * Generic JSON webhook sink — spread into watch():
 *   client.watch({ ...webhookSink("https://hooks.example/tendb") })
 * Posts `{ event: "alert" | "recover", finding?, code?, at }`. Swap for a
 * Slack/PagerDuty-specific callback later without touching the watcher.
 */
export function webhookSink(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Pick<WatchOptions, "onAlert" | "onRecover"> {
  const post = (body: unknown) =>
    fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => {});
  return {
    onAlert: (finding) => void post({ event: "alert", finding, at: new Date().toISOString() }),
    onRecover: (code) => void post({ event: "recover", code, at: new Date().toISOString() }),
  };
}

/**
 * Slack incoming-webhook sink — spread into watch():
 *   client.watch({ ...slackSink("https://hooks.slack.com/services/…") })
 */
export function slackSink(
  webhookUrl: string,
  opts: { source?: string; consoleUrl?: string } = {},
): Pick<WatchOptions, "onAlert" | "onRecover"> {
  return {
    onAlert: (finding) =>
      void postToSlack(
        webhookUrl,
        { at: new Date().toISOString(), type: "alert", code: finding.code, finding },
        fetch,
        opts,
      ),
    onRecover: (code) =>
      void postToSlack(
        webhookUrl,
        { at: new Date().toISOString(), type: "recover", code },
        fetch,
        opts,
      ),
  };
}

export {
  evaluateCheckup,
  DEFAULT_THRESHOLDS,
  debounceUnreachable,
  diffFindings,
  slackPayload,
  postToSlack,
};
export type { AlertEvent };
export type {
  ApiSession,
  Branch,
  Clone,
  InstanceStatus,
  Snapshot,
  SnapshotScheduleConfig,
  SchemaDiff,
  SchemaSyncConfig,
  Checkup,
  CheckupThresholds,
  Finding,
  FindingCode,
  ReplicationStatus,
  ReplicationUrls,
  BranchUrl,
  ExecResult,
  MigrateOptions,
  MigrateResult,
};
export { TenDBError, NotFoundError, TimeoutError, UsageError, CapacityError } from "./errors.js";
