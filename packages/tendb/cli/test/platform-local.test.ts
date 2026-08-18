import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileParamStore, createLocalAdapter, identityTunnel, localParamsPath } from "../src/platform/local.js";
import { discover } from "../src/platform/discover.js";
import { resolveConfig } from "../src/config.js";
import { PlatformDownError } from "../src/errors.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tendb-local-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("FileParamStore", () => {
  it("round-trips values and keeps the file at 0600", async () => {
    const store = new FileParamStore(join(dir, "params.json"));
    await store.putParameter("/tendb/instance-id", "dblab_server");
    await store.putParameter("/tendb/verification-token", "sekrit", true);

    expect(await store.getParameter("/tendb/instance-id")).toBe("dblab_server");
    expect(await store.getParameter("/tendb/verification-token")).toBe("sekrit");
    expect(await store.getParameter("/tendb/absent")).toBeNull();

    const mode = statSync(join(dir, "params.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("reads fresh state on every call (snapshotd writes the same file)", async () => {
    const path = join(dir, "params.json");
    const store = new FileParamStore(path);
    await store.putParameter("/tendb/snapshots/request", "req-1");
    // Another process (snapshotd) rewrites the file out from under us.
    writeFileSync(path, JSON.stringify({ "/tendb/snapshots/request": { value: "req-2" } }));
    expect(await store.getParameter("/tendb/snapshots/request")).toBe("req-2");
  });

  it("marks secure values so terraform/snapshotd can tell them apart", async () => {
    const path = join(dir, "params.json");
    const store = new FileParamStore(path);
    await store.putParameter("/tendb/alerts/slack-webhook", "https://hooks", true);
    const raw = JSON.parse(readFileSync(path, "utf8"));
    expect(raw["/tendb/alerts/slack-webhook"]).toEqual({ value: "https://hooks", secure: true });
  });
});

describe("discover over a params.json", () => {
  const cfg = (stateDir: string) =>
    resolveConfig({ flags: { platform: "local", stateDir }, configPath: "", processEnv: {} });

  it("throws PlatformDownError when the file (or instance-id) is missing", async () => {
    const store = new FileParamStore(localParamsPath(dir));
    await expect(discover(store, cfg(dir))).rejects.toBeInstanceOf(PlatformDownError);
  });

  it("returns the contract values once terraform wrote them", async () => {
    const store = new FileParamStore(localParamsPath(dir));
    await store.putParameter("/tendb/instance-id", "dblab_server");
    await store.putParameter("/tendb/verification-token", "tok", true);
    await store.putParameter("/tendb/dbname", "appdb");
    await store.putParameter("/tendb/host", "127.0.0.1");

    const found = await discover(store, cfg(dir));
    expect(found).toEqual({ instanceId: "dblab_server", token: "tok", database: "appdb", host: "127.0.0.1" });
  });
});

describe("identityTunnel", () => {
  let upstream: Server;
  let upstreamPort: number;

  beforeEach(async () => {
    upstream = createServer((sock) => {
      sock.end("pong");
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    upstreamPort = (upstream.address() as { port: number }).port;
  });

  afterEach(() => {
    upstream.close();
  });

  it("is a no-op when the local port matches (ports already on loopback)", async () => {
    const t = await identityTunnel(6000);
    expect(t.localPort).toBe(6000);
    expect(t.remotePort).toBe(6000);
    await t.close();
  });

  it("relays TCP when a different local port is requested (tendb tunnel -p)", async () => {
    const t = await identityTunnel(upstreamPort, upstreamPort + 1);
    const reply = await new Promise<string>((resolve, reject) => {
      const sock = connect(t.localPort, "127.0.0.1");
      let buf = "";
      sock.on("data", (d) => (buf += d.toString()));
      sock.on("end", () => resolve(buf));
      sock.on("error", reject);
    });
    expect(reply).toBe("pong");
    await t.close();
  });
});

describe("createLocalAdapter", () => {
  it("exposes the local transport and a file-backed store", async () => {
    const adapter = createLocalAdapter({ stateDir: dir });
    expect(adapter.platform).toBe("local");
    expect(adapter.transport).toBe("local");
    await adapter.params.putParameter("/tendb/port-pool", "6000-6009");
    expect(await adapter.params.getParameter("/tendb/port-pool")).toBe("6000-6009");
    const t = await adapter.openTunnel("dblab_server", 2345);
    expect(t.localPort).toBe(2345);
    await t.close();
    await adapter.close();
  });
});
