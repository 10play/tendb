import { describe, expect, it } from "vitest";
import { evaluateCheckup, DEFAULT_THRESHOLDS, type CheckupInputs } from "../src/monitor/checkup.js";

const NOW = Date.UTC(2026, 7, 17, 12, 0, 0);

function healthyInputs(overrides: Partial<CheckupInputs> = {}): CheckupInputs {
  return {
    healthy: true,
    now: NOW,
    status: {
      retrieving: { status: "finished", alerts: {} },
      pools: [
        {
          dataStateAt: "20260817110000", // 1h old
          fileSystem: { size: 100, used: 10, free: 90 },
        },
      ],
      cloning: { clones: [{ id: "a", status: { code: "OK" } }] },
    },
    cloneCapacity: 10,
    ...overrides,
  };
}

describe("evaluateCheckup", () => {
  it("returns no findings for a healthy platform", () => {
    expect(evaluateCheckup(healthyInputs())).toEqual([]);
  });

  it("flags an unreachable engine as critical", () => {
    const findings = evaluateCheckup({ healthy: false, now: NOW });
    expect(findings).toMatchObject([{ code: "engine-unreachable", severity: "critical" }]);
  });

  it("warns when the pool data state exceeds the staleness threshold", () => {
    const inputs = healthyInputs();
    inputs.status!.pools![0]!.dataStateAt = "20260814120000"; // 72h old
    const findings = evaluateCheckup(inputs);
    expect(findings).toMatchObject([{ code: "data-stale", severity: "warning", value: 72 }]);
    // Custom threshold clears it.
    expect(evaluateCheckup(inputs, { dataStaleHours: 100 })).toEqual([]);
  });

  it("parses ISO data-state timestamps too", () => {
    const inputs = healthyInputs();
    inputs.status!.pools![0]!.dataStateAt = "2026-08-14T12:00:00Z";
    expect(evaluateCheckup(inputs)).toMatchObject([{ code: "data-stale" }]);
  });

  it("escalates disk usage from warning to critical", () => {
    const inputs = healthyInputs();
    inputs.status!.pools![0]!.fileSystem = { size: 100, used: 85, free: 15 };
    expect(evaluateCheckup(inputs)).toMatchObject([{ code: "disk-usage", severity: "warning" }]);
    inputs.status!.pools![0]!.fileSystem = { size: 100, used: 95, free: 5 };
    expect(evaluateCheckup(inputs)).toMatchObject([{ code: "disk-usage", severity: "critical" }]);
  });

  it("tracks clone capacity through warn and full", () => {
    const clones = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, status: { code: "OK" } }));
    const inputs = healthyInputs();
    inputs.status!.cloning = { clones: clones(8) };
    expect(evaluateCheckup(inputs)).toMatchObject([{ code: "clone-capacity", severity: "warning" }]);
    inputs.status!.cloning = { clones: clones(10) };
    expect(evaluateCheckup(inputs)).toMatchObject([{ code: "clone-capacity", severity: "critical" }]);
  });

  it("covers the replication rules", () => {
    const base = healthyInputs();
    const repl = (replication: CheckupInputs["replication"]) =>
      evaluateCheckup({ ...base, replication });

    expect(
      repl({ configured: true, publisher: { connected: false, error: "timeout" }, measuredAt: "" }),
    ).toMatchObject([{ code: "replication-publisher", severity: "critical" }]);

    expect(
      repl({
        configured: true,
        publisher: { connected: true, slots: [{ name: "s", active: false, lagBytes: 1 }] },
        subscriber: {
          connected: true,
          subscriptions: [
            {
              name: "s",
              enabled: false,
              receivedLsn: null,
              lastMessageAt: null,
              secondsSinceLastMessage: 999,
              applyErrors: 2,
              syncErrors: 0,
            },
          ],
        },
        measuredAt: "",
      }),
    ).toMatchObject([
      { code: "subscription-disabled", severity: "critical" },
      { code: "replication-errors", severity: "warning" },
      { code: "replication-stale", severity: "warning" },
      { code: "slot-inactive", severity: "warning" },
    ]);

    expect(
      repl({
        configured: true,
        publisher: {
          connected: true,
          slots: [{ name: "s", active: true, lagBytes: DEFAULT_THRESHOLDS.replicationLagBytes + 1 }],
        },
        measuredAt: "",
      }),
    ).toMatchObject([{ code: "replication-lag", severity: "warning" }]);

    // Streaming healthy → silent.
    expect(
      repl({
        configured: true,
        publisher: { connected: true, slots: [{ name: "s", active: true, lagBytes: 0 }] },
        subscriber: {
          connected: true,
          subscriptions: [
            {
              name: "s",
              enabled: true,
              receivedLsn: "0/1",
              lastMessageAt: null,
              secondsSinceLastMessage: 1,
              applyErrors: 0,
              syncErrors: 0,
            },
          ],
        },
        measuredAt: "",
      }),
    ).toEqual([]);
  });
});

describe("streaming staleness default", () => {
  it("tightens data-stale to 2h when replication is configured", () => {
    const inputs = healthyInputs();
    inputs.status!.pools![0]!.dataStateAt = "20260817090000"; // 3h old vs NOW
    // Without streaming: 3h < 26h → silent.
    expect(evaluateCheckup(inputs)).toEqual([]);
    // With streaming, the clock is the newest SNAPSHOT: 3h > 2h → warns.
    const streaming = {
      ...inputs,
      latestSnapshotAt: "20260817090000",
      replication: {
        configured: true,
        publisher: { connected: true, slots: [{ name: "s", active: true, lagBytes: 0 }] },
        measuredAt: "",
      },
    };
    expect(evaluateCheckup(streaming)).toMatchObject([{ code: "data-stale", threshold: 2 }]);
    // Explicit override still wins.
    expect(evaluateCheckup(streaming, { dataStaleHours: 26 })).toEqual([]);
  });
});

describe("streaming data clock", () => {
  it("uses the newest snapshot, not the frozen pool dataStateAt", () => {
    const inputs = healthyInputs();
    inputs.status!.pools![0]!.dataStateAt = "20260810000000"; // frozen a week ago
    inputs.replication = {
      configured: true,
      publisher: { connected: true, slots: [{ name: "s", active: true, lagBytes: 0 }] },
      measuredAt: "",
    };
    // Fresh snapshot 30min ago → silent despite the ancient pool field.
    inputs.latestSnapshotAt = "2026-08-17T11:30:00Z";
    expect(evaluateCheckup(inputs)).toEqual([]);
    // Old snapshot → warns with the snapshotd message.
    inputs.latestSnapshotAt = "2026-08-17T08:00:00Z"; // 4h
    expect(evaluateCheckup(inputs)).toMatchObject([
      { code: "data-stale", message: expect.stringContaining("snapshotd") },
    ]);
    // Listing blipped (null) → rule skipped, no false flap.
    inputs.latestSnapshotAt = null;
    expect(evaluateCheckup(inputs)).toEqual([]);
  });
});

describe("diffFindings", () => {
  it("emits transitions only: appear, escalate, clear", async () => {
    const { diffFindings } = await import("../src/monitor/checkup.js");
    const seen = new Map();
    const warn = { code: "disk-usage", severity: "warning", message: "m" } as const;
    const crit = { code: "disk-usage", severity: "critical", message: "m" } as const;

    let d = diffFindings(seen, [warn]);
    expect(d.alerts).toHaveLength(1);
    d = diffFindings(seen, [warn]); // steady state → silent
    expect(d.alerts).toHaveLength(0);
    d = diffFindings(seen, [crit]); // escalation → re-alert
    expect(d.alerts).toHaveLength(1);
    d = diffFindings(seen, []); // cleared → recover
    expect(d.recovers).toEqual(["disk-usage"]);
  });
});

describe("debounceUnreachable", () => {
  const unreachable = {
    code: "engine-unreachable",
    severity: "critical",
    message: "DBLab engine did not answer /healthz",
  } as const;
  const checkupWith = (findings: (typeof unreachable)[]) => ({
    ok: findings.length === 0,
    findings: [...findings],
    measuredAt: "2026-08-17T18:37:30.000Z",
  });

  it("suppresses a single blip (snapshot-rescan restart) but not a real outage", async () => {
    const { debounceUnreachable } = await import("../src/monitor/checkup.js");
    const state = { streak: 0 };

    // Tick 1: probe landed in the ~2s restart window → suppressed.
    let c = debounceUnreachable(checkupWith([unreachable]), state);
    expect(c.findings).toHaveLength(0);
    expect(c.ok).toBe(true);
    // Tick 2: still down → a real outage, alert passes through.
    c = debounceUnreachable(checkupWith([unreachable]), state);
    expect(c.findings).toEqual([unreachable]);
    expect(c.ok).toBe(false);
    // Recovery resets the streak — the next blip is again a lone blip.
    c = debounceUnreachable(checkupWith([]), state);
    expect(state.streak).toBe(0);
    c = debounceUnreachable(checkupWith([unreachable]), state);
    expect(c.findings).toHaveLength(0);
  });

  it("leaves other findings untouched while suppressing", async () => {
    const { debounceUnreachable } = await import("../src/monitor/checkup.js");
    const drift = { code: "schema-drift", severity: "warning", message: "m" } as const;
    const c = debounceUnreachable(
      { ok: false, findings: [unreachable, drift], measuredAt: "2026-08-17T18:37:30.000Z" },
      { streak: 0 },
    );
    expect(c.findings).toEqual([drift]);
    expect(c.ok).toBe(true); // remaining finding is only a warning
  });
});

describe("schema-drift", () => {
  const withSchemas = (
    pub: Record<string, string>,
    sub: Record<string, string>,
  ): CheckupInputs => ({
    ...healthyInputs(),
    latestSnapshotAt: "20260817113000",
    replication: {
      configured: true,
      publisher: { connected: true, slots: [{ name: "s", active: true, lagBytes: 0 }], tables: pub },
      subscriber: {
        connected: true,
        subscriptions: [
          {
            name: "s",
            enabled: true,
            receivedLsn: "0/1",
            lastMessageAt: null,
            secondsSinceLastMessage: 1,
            applyErrors: 0,
            syncErrors: 0,
          },
        ],
        tables: sub,
      },
      measuredAt: "",
    },
  });

  it("silent when fingerprints match", () => {
    expect(evaluateCheckup(withSchemas({ a: "x" }, { a: "x" }))).toEqual([]);
  });

  it("flags missing, orphaned, and mismatched tables in one finding", () => {
    const findings = evaluateCheckup(
      withSchemas({ a: "x", added: "y" }, { a: "CHANGED", dropped: "z" }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ code: "schema-drift", severity: "warning", value: 3 });
    expect(findings[0]!.message).toContain("added");
    expect(findings[0]!.message).toContain("dropped");
    expect(findings[0]!.message).toContain("a");
  });
});
