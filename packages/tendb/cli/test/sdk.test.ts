import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockDblab } from "./mock-dblab.js";
import { createClient, type TenDBClient } from "../src/sdk.js";
import { DblabClient } from "../src/dblab/client.js";
import type { SsmFacade } from "../src/aws/params.js";
import { createSnapshotNow, getScheduleConfig, setScheduleConfig } from "../src/snapshots.js";

let mock: MockDblab;
let client: TenDBClient;
let apiUrl: string;

beforeEach(async () => {
  mock = new MockDblab();
  apiUrl = await mock.listen();
  // Direct transport: no AWS, no tunnels — the SDK's in-VPC/test mode.
  client = createClient({ apiUrl, token: mock.token, database: "appdb", configPath: undefined, cwd: "/" });
});

afterEach(async () => {
  await client.close();
  await mock.close();
});

describe("branches", () => {
  it("creates, lists, and deletes through the workflow layer", async () => {
    const created = await client.branches.create("sdk-a");
    expect(created).toMatchObject({ name: "sdk-a", state: "OK" });
    expect(created.uri).toContain("sdk_a");

    const listed = await client.branches.list();
    expect(listed.map((b) => b.name)).toContain("sdk-a");
    expect(listed.find((b) => b.name === "sdk-a")?.clone?.state).toBe("OK");

    await client.branches.delete("sdk-a");
    expect(mock.clones.size).toBe(0);
  });
});

describe("exec / withBranch / migrate", () => {
  it("passes DATABASE_URL to the child and propagates its exit code", async () => {
    await client.branches.create("sdk-exec");
    const ok = await client.exec("sdk-exec", [
      process.execPath,
      "-e",
      "process.exit(process.env.DATABASE_URL && process.env.DATABASE_URL.includes('sdk_exec') ? 0 : 7)",
    ]);
    expect(ok.exitCode).toBe(0);

    const failing = await client.exec("sdk-exec", [process.execPath, "-e", "process.exit(3)"]);
    expect(failing.exitCode).toBe(3);
  });

  it("withBranch deletes the branch afterwards — including on throw", async () => {
    const result = await client.withBranch("sdk-ephemeral", async (branch) => {
      expect(branch.url).toContain("appdb");
      expect(mock.clones.has("sdk-ephemeral")).toBe(true);
      return "done";
    });
    expect(result).toBe("done");
    expect(mock.clones.has("sdk-ephemeral")).toBe(false);

    await expect(
      client.withBranch("sdk-throws", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(mock.clones.has("sdk-throws")).toBe(false);
  });

  it("migrate rehearses on a scratch branch and cleans it up", async () => {
    const result = await client.migrate({
      command: [process.execPath, "-e", "process.exit(0)"],
    });
    expect(result.ok).toBe(true);
    expect(result.kept).toBe(false);
    expect(result.branch).toMatch(/^migrate-/);
    expect(mock.clones.size).toBe(0);

    const failed = await client.migrate({
      command: [process.execPath, "-e", "process.exit(4)"],
    });
    expect(failed).toMatchObject({ ok: false, exitCode: 4 });
    expect(mock.clones.size).toBe(0);
  });
});

describe("status / checkup", () => {
  it("reports engine health and evaluates findings", async () => {
    const status = await client.status();
    expect(status.healthy).toBe(true);
    expect(status.instance?.engine ?? status.instance).toBeDefined();

    const checkup = await client.checkup({ dataStaleHours: 24 * 365 * 10 });
    expect(checkup.ok).toBe(true);
    expect(Array.isArray(checkup.findings)).toBe(true);
  });
});

describe("snapshots", () => {
  const stubSsm = (
    store: Map<string, string>,
    onPut?: (name: string, value: string) => void,
  ): SsmFacade => ({
    profile: undefined,
    region: async () => "test",
    getParameter: async (name: string) => store.get(name) ?? null,
    putParameter: async (name: string, value: string) => {
      store.set(name, value);
      onPut?.(name, value);
    },
    startSession: async () => {
      throw new Error("not used in tests");
    },
    terminateSession: async () => {},
  });

  it("createSnapshotNow writes a request nonce and returns the new pool snapshot", async () => {
    const dblab = new DblabClient(apiUrl, mock.token);
    const store = new Map<string, string>();
    // Simulate the on-host executor: a new request nonce produces a snapshot.
    const ssm = stubSsm(store, (name) => {
      if (name === "/tendb/snapshots/request") {
        mock.snapshots.push({
          id: "dblab_pool@snapshot_20260817999999",
          createdAt: "2026-08-17T14:30:00Z",
          dataStateAt: "2026-08-17T14:30:00Z",
        });
      }
    });

    const snapshot = await createSnapshotNow(dblab, ssm, "/tendb", { pollMs: 20, timeoutMs: 3_000 });
    expect(snapshot.id).toBe("dblab_pool@snapshot_20260817999999");
    expect(store.get("/tendb/snapshots/request")).toMatch(/^req-/);
  });

  it("createSnapshotNow times out when the executor never responds", async () => {
    const dblab = new DblabClient(apiUrl, mock.token);
    await expect(
      createSnapshotNow(dblab, stubSsm(new Map()), "/tendb", { pollMs: 20, timeoutMs: 150 }),
    ).rejects.toThrow(/no new snapshot/);
  });

  it("schedule config round-trips and rejects nonsense", async () => {
    const store = new Map<string, string>();
    const ssm = stubSsm(store);
    await setScheduleConfig(ssm, "/tendb", { intervalMinutes: 60, retain: 24 });
    expect(await getScheduleConfig(ssm, "/tendb")).toEqual({ intervalMinutes: 60, retain: 24 });
    await expect(
      setScheduleConfig(ssm, "/tendb", { intervalMinutes: -1, retain: 24 }),
    ).rejects.toThrow(/intervalMinutes/);
    await expect(
      setScheduleConfig(ssm, "/tendb", { intervalMinutes: 60, retain: 0 }),
    ).rejects.toThrow(/retain/);
  });
});

describe("schema sync config", () => {
  it("validates and round-trips {autoSync}", async () => {
    const { getSchemaConfig, setSchemaConfig } = await import("../src/schema-sync.js");
    const store = new Map<string, string>();
    const ssm = {
      profile: undefined,
      region: async () => "test",
      getParameter: async (name: string) => store.get(name) ?? null,
      putParameter: async (name: string, value: string) => void store.set(name, value),
      startSession: async () => {
        throw new Error("unused");
      },
      terminateSession: async () => {},
    };
    await setSchemaConfig(ssm, "/tendb", { autoSync: true });
    expect(await getSchemaConfig(ssm, "/tendb")).toEqual({ autoSync: true });
    await expect(
      setSchemaConfig(ssm, "/tendb", { autoSync: "yes" } as never),
    ).rejects.toThrow(/autoSync/);
  });

  it("diffSchemas partitions missing / orphaned / mismatched", async () => {
    const { diffSchemas } = await import("../src/console/replication.js");
    expect(diffSchemas({ a: "1", b: "2", c: "3" }, { b: "2", c: "DIFF", d: "4" })).toEqual({
      missing: ["a"],
      orphaned: ["d"],
      mismatched: ["c"],
      indexesDiffer: [],
    });
  });

  it("diffSchemas reports index drift only for tables present on both sides", async () => {
    const { diffSchemas } = await import("../src/console/replication.js");
    // b: index fp differs · c: index only upstream · missing/orphaned tables
    // excluded even though their index maps disagree too.
    expect(
      diffSchemas(
        { a: "1", b: "2", c: "3" },
        { b: "2", c: "3", d: "4" },
        { a: "i1", b: "i2", c: "i3" },
        { b: "OTHER", d: "i4" },
      ),
    ).toEqual({
      missing: ["a"],
      orphaned: ["d"],
      mismatched: [],
      indexesDiffer: ["b", "c"],
    });
  });
});
