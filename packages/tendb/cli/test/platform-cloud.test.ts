import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MockDblab } from "./mock-dblab.js";
import { createGcpAdapter, parseGcpInstancePath } from "../src/platform/gcp.js";
import { createAzureAdapter, parseBastionId } from "../src/platform/azure.js";
import { FileParamStore } from "../src/platform/local.js";
import type { ParamStore, Tunnel } from "../src/platform/types.js";
import { MissingDependencyError, TenDBError } from "../src/errors.js";

const fakeBinDir = join(dirname(fileURLToPath(import.meta.url)), "bin");

let dir: string;
let savedPath: string;
let mock: MockDblab;
let tunnel: Tunnel | undefined;

beforeAll(() => {
  savedPath = process.env.PATH!;
  process.env.PATH = `${fakeBinDir}:${savedPath}`;
});

afterAll(() => {
  process.env.PATH = savedPath;
});

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "tendb-cloud-"));
  process.env.TENDB_FAKE_GCLOUD_STORE = join(dir, "gcloud.json");
  process.env.TENDB_FAKE_AZ_STORE = join(dir, "az.json");
  mock = new MockDblab();
  process.env.TENDB_FAKE_TUNNEL_TARGET = (await mock.listen()).replace("http://", "tcp://");
});

afterEach(async () => {
  await tunnel?.close();
  tunnel = undefined;
  await mock.close();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * The ParamStore contract, run against every cloud implementation (through
 * the CLI fakes) and the real file-backed local store. AWS's SsmFacade is
 * covered by sdk.test.ts's Map stub — same structural contract.
 */
describe.each([
  ["gcp", (): ParamStore => createGcpAdapter({ gcpProject: "test-project" }).params],
  ["azure", (): ParamStore => createAzureAdapter({ azureVault: "kv-test", ssmPrefix: "/tendb" }).params],
  ["local", (): ParamStore => new FileParamStore(join(tmpdir(), `tendb-contract-${process.pid}`, "params.json"))],
])("ParamStore contract: %s", (name, make) => {
  it("get of an absent param is null, put round-trips, overwrite wins", async () => {
    const store = make();
    expect(await store.getParameter("/tendb/instance-id")).toBeNull();
    await store.putParameter("/tendb/instance-id", "target-1");
    expect(await store.getParameter("/tendb/instance-id")).toBe("target-1");
    await store.putParameter("/tendb/instance-id", "target-2");
    expect(await store.getParameter("/tendb/instance-id")).toBe("target-2");
    await store.putParameter("/tendb/alerts/slack-webhook", "https://hooks.example", true);
    expect(await store.getParameter("/tendb/alerts/slack-webhook", true)).toBe("https://hooks.example");
    if (name === "local") rmSync(dirname(join(tmpdir(), `tendb-contract-${process.pid}`, "params.json")), { recursive: true, force: true });
  });
});

describe("gcp adapter", () => {
  it("opens an IAP tunnel that proxies to the engine and closes cleanly", async () => {
    const adapter = createGcpAdapter({ gcpProject: "p" });
    tunnel = await adapter.openTunnel("projects/p/zones/europe-north1-a/instances/tendb", 2345);
    const res = await fetch(`http://127.0.0.1:${tunnel.localPort}/healthz`, {
      headers: { "Verification-Token": mock.token },
    });
    expect(res.ok).toBe(true);
    await tunnel.close();
    tunnel = undefined;
  });

  it("rejects a malformed instance path with guidance", () => {
    expect(() => parseGcpInstancePath("i-0abc123")).toThrowError(TenDBError);
    expect(parseGcpInstancePath("projects/p/zones/z/instances/n")).toEqual({
      project: "p",
      zone: "z",
      name: "n",
    });
  });
});

describe("azure adapter", () => {
  const BASTION_ID =
    "/subscriptions/s-1/resourceGroups/rg-tendb/providers/Microsoft.Network/bastionHosts/tendb-bastion";
  const VM_ID =
    "/subscriptions/s-1/resourceGroups/rg-tendb/providers/Microsoft.Compute/virtualMachines/tendb";

  it("reads bastion-id from the vault and opens a Bastion tunnel", async () => {
    const adapter = createAzureAdapter({ azureVault: "kv-test", ssmPrefix: "/tendb" });
    await adapter.params.putParameter("/tendb/bastion-id", BASTION_ID);
    tunnel = await adapter.openTunnel(VM_ID, 2345);
    const res = await fetch(`http://127.0.0.1:${tunnel.localPort}/healthz`, {
      headers: { "Verification-Token": mock.token },
    });
    expect(res.ok).toBe(true);
    await tunnel.close();
    tunnel = undefined;
  });

  it("fails with guidance when bastion-id is absent", async () => {
    const adapter = createAzureAdapter({ azureVault: "kv-test", ssmPrefix: "/tendb" });
    await expect(adapter.openTunnel(VM_ID, 2345)).rejects.toThrowError(/bastion-id/);
  });

  it("rejects a malformed bastion id", () => {
    expect(() => parseBastionId("not-a-resource-id")).toThrowError(TenDBError);
    expect(parseBastionId(BASTION_ID)).toEqual({ resourceGroup: "rg-tendb", name: "tendb-bastion" });
  });
});

describe("missing CLIs", () => {
  it("ENOENT becomes MissingDependencyError with an install hint", async () => {
    const emptyBin = join(dir, "empty-bin");
    writeFileSync(join(dir, "placeholder"), "");
    process.env.PATH = emptyBin;
    try {
      const gcp = createGcpAdapter({ gcpProject: "p" });
      await expect(
        gcp.openTunnel("projects/p/zones/z/instances/n", 2345),
      ).rejects.toThrowError(MissingDependencyError);
      const az = createAzureAdapter({ azureVault: "kv", ssmPrefix: "/tendb" });
      await expect(az.params.getParameter("/tendb/instance-id")).rejects.toThrowError(
        MissingDependencyError,
      );
    } finally {
      process.env.PATH = `${fakeBinDir}:${savedPath}`;
    }
  });
});
