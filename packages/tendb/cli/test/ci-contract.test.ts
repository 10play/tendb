import { execFileSync, execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { MockDblab } from "./mock-dblab.js";

const cliDir = fileURLToPath(new URL("..", import.meta.url));
const binary = join(cliDir, "dist", "index.js");

let mock: MockDblab;
let apiUrl: string;

function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveRun) => {
    execFile(
      process.execPath,
      [binary, ...args],
      {
        env: {
          ...process.env,
          TENDB_API_URL: apiUrl,
          TENDB_TOKEN: mock.token,
          TENDB_DATABASE: "appdb",
          TENDB_CONFIG: "", // make sure no repo tendb.json interferes
        },
        cwd: cliDir,
      },
      (err, stdout, stderr) => {
        resolveRun({ code: (err as { code?: number } | null)?.code ?? 0, stdout, stderr });
      },
    );
  });
}

beforeAll(() => {
  // Contract tests exercise the BUILT binary — same artifact CI would run.
  if (!existsSync(binary)) {
    execFileSync("pnpm", ["build:cli"], { cwd: cliDir, stdio: "inherit" });
  }
});

beforeEach(async () => {
  mock = new MockDblab();
  apiUrl = await mock.listen();
});

afterAll(async () => {
  await mock.close();
});

describe("ci ensure", () => {
  it("prints the URI as the LAST stdout line, progress on stderr, exit 0", async () => {
    const res = await run(["ci", "ensure", "7"]);
    expect(res.code).toBe(0);
    const lines = res.stdout.trim().split("\n");
    const last = lines[lines.length - 1]!;
    expect(last).toMatch(/^postgres:\/\/pr_7:[0-9a-f]{32}@10\.40\.1\.99:\d+\/appdb$/);
    // stdout purity: the URI is the only stdout content
    expect(lines).toHaveLength(1);
    expect(res.stderr).toContain("creating clone pr-7");
  });

  it("exits 42 on capacity exhaustion", async () => {
    mock.failNextCloneCreate = { status: 400, message: "pool of ports is exhausted" };
    const res = await run(["ci", "ensure", "9"]);
    expect(res.code).toBe(42);
    expect(res.stdout).toBe("");
  });
});

describe("ci url", () => {
  it("prints the URI for an existing clone", async () => {
    await run(["ci", "ensure", "7"]);
    const res = await run(["ci", "url", "7"]);
    expect(res.code).toBe(0);
    expect(res.stdout.trim()).toMatch(/^postgres:\/\/pr_7:/);
  });

  it("exits 3 when the clone is missing", async () => {
    const res = await run(["ci", "url", "404"]);
    expect(res.code).toBe(3);
    expect(res.stdout).toBe("");
  });
});

describe("ci delete", () => {
  it("deletes and exits 0; repeat delete also exits 0", async () => {
    await run(["ci", "ensure", "7"]);
    expect((await run(["ci", "delete", "7"])).code).toBe(0);
    expect((await run(["ci", "delete", "7"])).code).toBe(0);
    expect(mock.clones.has("pr-7")).toBe(false);
  });
});

describe("branches --output json", () => {
  it("emits parseable JSON", async () => {
    await run(["ci", "ensure", "7"]);
    const res = await run(["branches", "list", "--output", "json"]);
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.branches.some((b: { name: string }) => b.name === "pr-7")).toBe(true);
  });
});

describe("connection-string", () => {
  it("prints only the URI", async () => {
    await run(["ci", "ensure", "7"]);
    const res = await run(["connection-string", "pr-7", "--quiet"]);
    expect(res.code).toBe(0);
    expect(res.stdout.trim()).toMatch(/^postgres:\/\/pr_7:/);
    expect(res.stderr).toBe("");
  });
});

describe("checkup", () => {
  it("emits parseable JSON and exits 0 when clean", async () => {
    const res = await run(["checkup", "--output", "json"]);
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.ok).toBe(true);
    expect(Array.isArray(parsed.findings)).toBe(true);
  });
});

describe("migrate --scratch", () => {
  it("runs the command with DATABASE_URL, passes the exit code, cleans up", async () => {
    const ok = await run([
      "migrate", "--scratch", "--quiet", "--",
      process.execPath, "-e", "process.exit(process.env.DATABASE_URL ? 0 : 7)",
    ]);
    expect(ok.code).toBe(0);
    expect(mock.clones.size).toBe(0);

    const failing = await run([
      "migrate", "--scratch", "--quiet", "--",
      process.execPath, "-e", "process.exit(4)",
    ]);
    expect(failing.code).toBe(4);
    expect(mock.clones.size).toBe(0);
  });
});
