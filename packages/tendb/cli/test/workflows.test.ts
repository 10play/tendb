import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockDblab } from "./mock-dblab.js";
import { openSession, type ApiSession } from "../src/context.js";
import {
  deleteBranch,
  ensureBranch,
  getBranchClone,
  resetBranch,
  waitForFirstSnapshot,
} from "../src/dblab/workflows.js";
import { CapacityError, NotFoundError, TimeoutError } from "../src/errors.js";
import { derivePassword } from "../src/naming.js";
import { resolveConfig } from "../src/config.js";

let mock: MockDblab;
let session: ApiSession;

beforeEach(async () => {
  mock = new MockDblab();
  const apiUrl = await mock.listen();
  session = await openSession(
    resolveConfig({
      processEnv: {} as NodeJS.ProcessEnv,
      cwd: "/",
      flags: { apiUrl, token: mock.token, database: "appdb", cloneTimeoutSeconds: 10 },
    }),
  );
});

afterEach(async () => {
  await session.close();
  await mock.close();
});

describe("ensureBranch", () => {
  it("creates branch + clone and returns the derived-password URI", async () => {
    const { clone, uri } = await ensureBranch(session, "pr-7");
    expect(clone.status.code).toBe("OK");
    expect(mock.branches.some((b) => b.name === "pr-7")).toBe(true);
    const expectedPassword = derivePassword(mock.token, "pr-7");
    expect(uri).toBe(`postgres://pr_7:${expectedPassword}@10.40.1.99:${clone.db?.port}/appdb`);
  });

  it("is idempotent: an OK clone short-circuits without re-creating", async () => {
    await ensureBranch(session, "pr-7");
    mock.requests.length = 0;
    const { uri } = await ensureBranch(session, "pr-7");
    expect(uri).toContain("pr_7");
    expect(mock.requests.filter((r) => r.method === "POST")).toHaveLength(0);
  });

  it("recreates a wedged (non-OK) clone", async () => {
    await ensureBranch(session, "pr-7");
    mock.clones.get("pr-7")!.statusQueue = ["EXITED"];
    const { clone } = await ensureBranch(session, "pr-7");
    expect(clone.status.code).toBe("OK");
  });

  it("maps port-pool exhaustion to CapacityError (exit 42)", async () => {
    mock.failNextCloneCreate = { status: 400, message: "pool of ports is exhausted" };
    await expect(ensureBranch(session, "pr-9")).rejects.toThrow(CapacityError);
  });

  it("surfaces FATAL clones as TimeoutError (exit 4)", async () => {
    mock.newCloneStatusQueue = ["CREATING", "FATAL"];
    await expect(ensureBranch(session, "pr-8")).rejects.toThrow(TimeoutError);
  });
});

describe("waitForFirstSnapshot", () => {
  it("times out when no snapshot appears", async () => {
    mock.snapshots = [];
    await expect(waitForFirstSnapshot(session, 1, 200)).rejects.toThrow(TimeoutError);
  });
});

describe("deleteBranch", () => {
  it("removes clone and branch, tolerating repeats", async () => {
    await ensureBranch(session, "pr-7");
    await deleteBranch(session, "pr-7");
    expect(mock.clones.has("pr-7")).toBe(false);
    expect(mock.branches.some((b) => b.name === "pr-7")).toBe(false);
    await deleteBranch(session, "pr-7"); // absent → still fine
  });
});

describe("resetBranch", () => {
  it("recreates the clone on its branch", async () => {
    const first = await ensureBranch(session, "pr-7");
    const reset = await resetBranch(session, "pr-7");
    expect(reset.clone.status.code).toBe("OK");
    expect(reset.clone.db?.port).not.toBe(first.clone.db?.port); // new clone
  });

  it("refuses to reset a missing branch", async () => {
    await expect(resetBranch(session, "nope")).rejects.toThrow(NotFoundError);
  });
});

describe("getBranchClone", () => {
  it("throws NotFoundError (exit 3) for missing clones", async () => {
    await expect(getBranchClone(session, "missing")).rejects.toThrow(NotFoundError);
  });
});
