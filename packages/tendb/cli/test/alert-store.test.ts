import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AlertStateStore } from "../src/console/alert-store.js";
import type { AlertEvent } from "../src/monitor/slack.js";

const event = (i: number): AlertEvent => ({
  at: new Date(1700000000000 + i * 1000).toISOString(),
  type: "alert",
  code: "schema-drift",
  finding: { code: "schema-drift", severity: "warning", message: `m${i}` },
});

describe("AlertStateStore", () => {
  it("round-trips seen map and history", async () => {
    const dir = await mkdtemp(join(tmpdir(), "alert-store-"));
    const store = new AlertStateStore(dir);
    const seen = new Map([["schema-drift", "warning"]] as const);
    await store.save(seen as never, [event(1), event(2)]);

    const restored = await new AlertStateStore(dir).load();
    expect(restored).not.toBeNull();
    expect([...restored!.seen.entries()]).toEqual([["schema-drift", "warning"]]);
    expect(restored!.history).toHaveLength(2);
    expect(restored!.history[1]!.finding?.message).toBe("m2");
  });

  it("returns null for missing or corrupt files instead of throwing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "alert-store-"));
    expect(await new AlertStateStore(dir).load()).toBeNull();
    await writeFile(join(dir, "alerts.json"), "{not json", "utf8");
    expect(await new AlertStateStore(dir).load()).toBeNull();
    expect(await new AlertStateStore(undefined).load()).toBeNull();
  });

  it("caps restored history at 200 events", async () => {
    const dir = await mkdtemp(join(tmpdir(), "alert-store-"));
    const store = new AlertStateStore(dir);
    await store.save(new Map(), Array.from({ length: 250 }, (_, i) => event(i)));
    const restored = await new AlertStateStore(dir).load();
    expect(restored!.history).toHaveLength(200);
    expect(restored!.history[0]!.finding?.message).toBe("m50");
  });

  it("skips the write when the state is unchanged", async () => {
    const dir = await mkdtemp(join(tmpdir(), "alert-store-"));
    const store = new AlertStateStore(dir);
    const seen = new Map();
    await store.save(seen, [event(1)]);
    const first = await stat(join(dir, "alerts.json"));
    await new Promise((r) => setTimeout(r, 20));
    await store.save(seen, [event(1)]);
    const second = await stat(join(dir, "alerts.json"));
    expect(second.mtimeMs).toBe(first.mtimeMs);
    // Sanity: the on-disk payload is versioned JSON.
    const raw = JSON.parse(await readFile(join(dir, "alerts.json"), "utf8"));
    expect(raw.version).toBe(1);
  });
});
