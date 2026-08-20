import { describe, expect, it } from "vitest";
import {
  fetchReplicationStatus,
  normalizePublisher,
  normalizeSubscriber,
} from "../src/console/replication.js";

describe("normalizePublisher", () => {
  it("maps pg_stat rows into the wire shape, coercing bigint strings", () => {
    const status = normalizePublisher(
      { lsn: "0/3000148" },
      [
        {
          slot_name: "aurora_stream",
          active: true,
          wal_status: "reserved",
          lag_bytes: "128",
          wal_retained_bytes: "4096",
        },
      ],
      [
        {
          application_name: "aurora_stream",
          client_addr: "18.130.1.1",
          state: "streaming",
          write_lag_ms: "12.5",
          flush_lag_ms: null,
          replay_lag_ms: undefined,
        },
      ],
    );
    expect(status).toEqual({
      connected: true,
      currentLsn: "0/3000148",
      slots: [
        {
          name: "aurora_stream",
          active: true,
          lagBytes: 128,
          walRetainedBytes: 4096,
          walStatus: "reserved",
        },
      ],
      peers: [
        {
          applicationName: "aurora_stream",
          clientAddr: "18.130.1.1",
          state: "streaming",
          writeLagMs: 12.5,
          flushLagMs: null,
          replayLagMs: null,
        },
      ],
    });
  });

  it("keeps a never-confirmed slot's lag and retained WAL as null rather than 0", () => {
    const status = normalizePublisher(
      { lsn: "0/0" },
      [{ slot_name: "s", active: false, wal_status: null, lag_bytes: null, wal_retained_bytes: null }],
      [],
    );
    expect(status.slots?.[0]).toEqual({
      name: "s",
      active: false,
      lagBytes: null,
      walRetainedBytes: null,
      walStatus: null,
    });
  });
});

describe("normalizeSubscriber", () => {
  it("maps subscription rows, ISO-formatting timestamps and defaulting error counts", () => {
    const at = new Date("2026-08-17T10:00:00Z");
    const status = normalizeSubscriber([
      {
        subname: "aurora_stream",
        subenabled: true,
        received_lsn: "0/3000148",
        last_msg_receipt_time: at,
        seconds_since_last_message: "2.75",
        apply_error_count: null,
        sync_error_count: "3",
      },
    ]);
    expect(status).toEqual({
      connected: true,
      subscriptions: [
        {
          name: "aurora_stream",
          enabled: true,
          receivedLsn: "0/3000148",
          lastMessageAt: "2026-08-17T10:00:00.000Z",
          secondsSinceLastMessage: 2.75,
          applyErrors: 0,
          syncErrors: 3,
        },
      ],
    });
  });
});

describe("fetchReplicationStatus", () => {
  it("reports unconfigured without touching the network when no URLs are set", async () => {
    const status = await fetchReplicationStatus(undefined, undefined);
    expect(status.configured).toBe(false);
    expect(status.publisher).toBeUndefined();
    expect(status.subscriber).toBeUndefined();
  });

  it("degrades a side to connected:false on connection failure instead of throwing", async () => {
    const status = await fetchReplicationStatus(
      "postgres://u:p@127.0.0.1:1/db?connect_timeout=1",
      undefined,
    );
    expect(status.configured).toBe(true);
    expect(status.publisher?.connected).toBe(false);
    expect(status.publisher?.error).toBeTruthy();
    expect(status.subscriber).toBeUndefined();
  });
});
