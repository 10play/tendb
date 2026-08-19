import { describe, expect, it } from "vitest";
import type { ParamStore } from "../src/platform/types.js";
import { forceSchemaSync, requestSchemaSync } from "../src/schema-sync.js";
import { TimeoutError, UsageError } from "../src/errors.js";

/**
 * forceSchemaSync's fail-fast contract: the daemon answers the request nonce
 * via schema/sync-result, and the CLI surfaces {ok:false} errors immediately
 * instead of polling drift until the timeout. Drift itself is unreachable in
 * these tests (urls are null → schemaDrift throws → treated as unknown), so
 * every exit here is driven by the result param alone.
 */

class FakeParams implements ParamStore {
  store = new Map<string, string>();
  /** Called on every sync-request write — lets a test play the daemon. */
  constructor(private readonly onRequest?: (nonce: string, store: Map<string, string>) => void) {}

  async getParameter(name: string): Promise<string | null> {
    return this.store.get(name) ?? null;
  }

  async putParameter(name: string, value: string): Promise<void> {
    this.store.set(name, value);
    if (name.endsWith("/schema/sync-request")) this.onRequest?.(value, this.store);
  }
}

const NO_URLS = { publisher: null, subscriber: null };
const FAST = { pollMs: 5, timeoutMs: 250 };

describe("requestSchemaSync", () => {
  it("writes a fresh nonce and returns it", async () => {
    const params = new FakeParams();
    const nonce = await requestSchemaSync(params, "/tendb");
    expect(nonce).toMatch(/^sync-\d+-[0-9a-f]{8}$/);
    expect(params.store.get("/tendb/schema/sync-request")).toBe(nonce);
  });
});

describe("forceSchemaSync", () => {
  it("fails fast with the daemon's error when the result answers {ok:false}", async () => {
    const params = new FakeParams((nonce, store) => {
      store.set(
        "/tendb/schema/sync-result",
        JSON.stringify({ nonce, ok: false, error: "cannot reach the publisher from snapshotd" }),
      );
    });
    const err = await forceSchemaSync(params, "/tendb", NO_URLS, FAST).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UsageError);
    expect((err as UsageError).hint).toMatch(/cannot reach the publisher/);
  });

  it("ignores a stale result from an older request and times out", async () => {
    const params = new FakeParams();
    params.store.set(
      "/tendb/schema/sync-result",
      JSON.stringify({ nonce: "sync-0-deadbeef", ok: false, error: "old news" }),
    );
    await expect(forceSchemaSync(params, "/tendb", NO_URLS, FAST)).rejects.toThrow(TimeoutError);
  });

  it("ignores malformed results and times out rather than crashing", async () => {
    const params = new FakeParams((_nonce, store) => {
      store.set("/tendb/schema/sync-result", "not json {");
    });
    await expect(forceSchemaSync(params, "/tendb", NO_URLS, FAST)).rejects.toThrow(TimeoutError);
  });

  it("keeps waiting past an {ok:true} answer while drift is unknown", async () => {
    // Daemon says done, but drift cannot be read (both URLs null) — the CLI
    // must not report success it cannot verify, so it runs to the timeout.
    const params = new FakeParams((nonce, store) => {
      store.set("/tendb/schema/sync-result", JSON.stringify({ nonce, ok: true }));
    });
    await expect(forceSchemaSync(params, "/tendb", NO_URLS, FAST)).rejects.toThrow(TimeoutError);
  });
});
