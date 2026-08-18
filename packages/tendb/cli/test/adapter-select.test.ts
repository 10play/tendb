import { describe, expect, it } from "vitest";
import { createAdapter, createParamStore, mapParamName } from "../src/platform/index.js";
import { openSession } from "../src/context.js";
import { resolveConfig } from "../src/config.js";
import { UsageError } from "../src/errors.js";
import { MockDblab } from "./mock-dblab.js";

const cfg = (flags: Parameters<typeof resolveConfig>[0]["flags"]) =>
  resolveConfig({ flags, configPath: "", processEnv: {} });

describe("createAdapter", () => {
  it("defaults to aws and reports the ssm transport (status back-compat)", () => {
    const adapter = createAdapter(cfg({}));
    expect(adapter.platform).toBe("aws");
    expect(adapter.transport).toBe("ssm");
    expect(adapter.ssm).toBeDefined();
  });

  it("selects the local adapter", () => {
    const adapter = createAdapter(cfg({ platform: "local", stateDir: "/tmp/x" }));
    expect(adapter.platform).toBe("local");
    expect(adapter.transport).toBe("local");
    expect(adapter.ssm).toBeUndefined();
  });

  it("selects the gcp adapter with the iap transport", () => {
    const adapter = createAdapter(cfg({ platform: "gcp", gcpProject: "p" }));
    expect(adapter.platform).toBe("gcp");
    expect(adapter.transport).toBe("iap");
  });

  it("azure without a vault fails with a hint", () => {
    expect(() => createAdapter(cfg({ platform: "azure" }))).toThrowError(UsageError);
  });

  it("azure with a vault reports the bastion transport", () => {
    const adapter = createAdapter(cfg({ platform: "azure", azureVault: "kv-tendb" }));
    expect(adapter.platform).toBe("azure");
    expect(adapter.transport).toBe("bastion");
  });
});

describe("openSession precedence", () => {
  it("apiUrl beats platform: direct mode regardless of the platform setting", async () => {
    const mock = new MockDblab();
    const apiUrl = await mock.listen();
    try {
      const session = await openSession(
        cfg({ platform: "local", apiUrl, token: mock.token, database: "appdb" }),
      );
      expect(session.transport).toBe("direct");
      expect(session.canTunnel).toBe(false);
      expect(session.params).toBeUndefined();
      await session.close();
    } finally {
      await mock.close();
    }
  });
});

describe("createParamStore", () => {
  it("aws without a region fails with the AWS hint (unchanged behavior)", () => {
    expect(() => createParamStore(cfg({}))).toThrowError(/snapshot control needs AWS access/);
  });

  it("local yields a file-backed store without any cloud config", async () => {
    const store = createParamStore(cfg({ platform: "local", stateDir: "/tmp/tendb-nonexistent" }));
    expect(await store.getParameter("/tendb/anything")).toBeNull();
  });
});

describe("mapParamName (engine-contract goldens)", () => {
  it.each([
    ["aws", "/tendb/snapshots/config", "/tendb/snapshots/config"],
    ["local", "/tendb/instance-id", "/tendb/instance-id"],
    ["gcp", "/tendb/snapshots/config", "tendb_snapshots_config"],
    ["gcp", "/tendb/instance-id", "tendb_instance-id"],
    ["gcp", "/tendb/verification-token", "tendb_verification-token"],
    ["azure", "/tendb/snapshots/config", "tendb-snapshots-config"],
    ["azure", "/tendb/instance-id", "tendb-instance-id"],
    ["azure", "/tendb/replication/publisher-url", "tendb-replication-publisher-url"],
  ] as const)("%s: %s → %s", (platform, name, expected) => {
    expect(mapParamName(platform, name)).toBe(expected);
  });
});
