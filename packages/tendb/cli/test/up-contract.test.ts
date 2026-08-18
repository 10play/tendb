import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const cliDir = fileURLToPath(new URL("..", import.meta.url));
const binary = join(cliDir, "dist", "index.js");
const fakeBinDir = join(dirname(fileURLToPath(import.meta.url)), "bin");

let dir: string;
let tfLog: string;
let tfOutputs: string;

function tfCalls(): Array<{ args: string[]; cwd: string }> {
  if (!existsSync(tfLog)) return [];
  return readFileSync(tfLog, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function cannedOutputs(discovery: Record<string, unknown>): void {
  writeFileSync(
    tfOutputs,
    JSON.stringify({
      cli_discovery: { sensitive: false, type: "string", value: JSON.stringify(discovery) },
    }),
  );
}

function run(
  args: string[],
  opts: { cwd?: string; env?: Record<string, string>; withTerraform?: boolean } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const withTerraform = opts.withTerraform ?? true;
  return new Promise((resolveRun) => {
    execFile(
      process.execPath,
      [binary, ...args],
      {
        cwd: opts.cwd ?? dir,
        env: {
          ...process.env,
          PATH: withTerraform ? `${fakeBinDir}:${process.env.PATH}` : "/usr/bin:/bin",
          // NO TENDB_CONFIG override: these tests rely on finding the
          // scaffolded tendb.json from the tmp cwd (isolated from the repo).
          TENDB_FAKE_TF_LOG: tfLog,
          TENDB_FAKE_TF_OUTPUTS: tfOutputs,
          ...opts.env,
        },
      },
      (err, stdout, stderr) => {
        resolveRun({ code: (err as { code?: number } | null)?.code ?? 0, stdout, stderr });
      },
    );
  });
}

beforeAll(() => {
  if (!existsSync(binary)) {
    execFileSync("pnpm", ["build:cli"], { cwd: cliDir, stdio: "inherit" });
  }
});

beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "tendb-up-")));
  tfLog = join(dir, "tf-log.jsonl");
  tfOutputs = join(dir, "tf-outputs.json");
  await run(["init", "--platform", "local", "--yes"], { cwd: dir });
  rmSync(tfLog, { force: true }); // drop any noise before the command under test
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("tendb up", () => {
  it("runs init+apply in the deployDir and folds cli_discovery into tendb.json", async () => {
    cannedOutputs({ platform: "local", stateDir: "/vm/state" });
    const res = await run(["up", "--yes", "--skip-preflight"]);
    expect(res.stderr).not.toContain("error");
    expect(res.code).toBe(0);

    const calls = tfCalls();
    expect(calls.map((c) => c.args)).toEqual([
      ["init", "-input=false"],
      ["apply", "-input=false", "-auto-approve"],
      ["output", "-json"],
    ]);
    expect(calls[0]!.cwd).toBe(join(dir, "tendb"));

    const config = JSON.parse(readFileSync(join(dir, "tendb.json"), "utf8"));
    expect(config).toEqual({ platform: "local", deployDir: "tendb", stateDir: "/vm/state" });
    expect(res.stdout).toContain("tendb status");
  });

  it("honors --dir over deployDir and --no-init", async () => {
    cannedOutputs({ platform: "local" });
    const res = await run(["up", "--yes", "--skip-preflight", "--no-init", "--dir", join(dir, "tendb")], {
      cwd: tmpdir(), // cwd without a tendb.json in reach of the deploy dir
      env: { TENDB_CONFIG: join(dir, "tendb.json") },
    });
    expect(res.code).toBe(0);
    expect(tfCalls().map((c) => c.args[0])).toEqual(["apply", "output"]);
  });

  it("writes into environments[name] with --env", async () => {
    const configPath = join(dir, "tendb.json");
    const existing = JSON.parse(readFileSync(configPath, "utf8"));
    writeFileSync(
      configPath,
      JSON.stringify({ ...existing, environments: { staging: { platform: "local" } } }),
    );
    cannedOutputs({ platform: "local", stateDir: "/vm/staging" });
    const res = await run(["up", "--yes", "--skip-preflight", "--env", "staging"]);
    expect(res.code).toBe(0);
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    expect(config.environments.staging).toEqual({ platform: "local", stateDir: "/vm/staging" });
    expect(config.stateDir).toBeUndefined();
  });

  it("exits 2 when there is nothing to bring up", async () => {
    const empty = mkdtempSync(join(tmpdir(), "tendb-empty-"));
    try {
      const res = await run(["up", "--yes", "--skip-preflight"], { cwd: empty });
      expect(res.code).toBe(2);
      expect(res.stderr).toContain("tendb init");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("exits 5 with an install hint when terraform is missing", async () => {
    const res = await run(["up", "--yes", "--skip-preflight"], { withTerraform: false });
    expect(res.code).toBe(5);
    expect(res.stderr).toContain("terraform not found");
    expect(res.stderr).toContain("install terraform");
  });
});

describe("tendb up on azure (two-phase bootstrap)", () => {
  beforeEach(async () => {
    rmSync(join(dir, "tendb"), { recursive: true, force: true });
    rmSync(join(dir, "tendb.json"), { force: true });
    await run([
      "init", "--platform", "azure", "--yes", "--force",
      "--pg-version", "16", "--ssh-public-key", "ssh-ed25519 AAAA test",
    ]);
    rmSync(tfLog, { force: true });
  });

  it("targets the vault first, then applies fully once the secret exists", async () => {
    const azStore = join(dir, "az.json");
    writeFileSync(azStore, JSON.stringify({ "tendb-source-url": "postgres://x" }));
    cannedOutputs({ platform: "azure", paramPrefix: "/tendb", azureVault: "kv-fake" });
    const res = await run(["up", "--yes", "--skip-preflight"], {
      env: {
        TENDB_FAKE_AZ_STORE: azStore,
        TENDB_FAKE_TF_STATE_SHOW: '    name = "kv-fake"\n    resource_group_name = "tendb"\n',
      },
    });
    expect(res.stderr).not.toContain("error");
    expect(res.code).toBe(0);

    const argv = tfCalls().map((c) => c.args);
    expect(argv[0]).toEqual(["init", "-input=false"]);
    expect(argv[1]).toEqual([
      "apply", "-input=false", "-auto-approve",
      "-target=module.engine.azurerm_key_vault.this",
      "-target=module.engine.azurerm_role_assignment.deployer_secrets",
    ]);
    expect(argv[2]).toEqual(["state", "show", "-no-color", "module.engine.azurerm_key_vault.this"]);
    expect(argv[3]).toEqual(["apply", "-input=false", "-auto-approve"]);

    const config = JSON.parse(readFileSync(join(dir, "tendb.json"), "utf8"));
    expect(config.azureVault).toBe("kv-fake");
  });

  it("stops with the secret-set command when the secret is missing under --yes", async () => {
    const azStore = join(dir, "az.json");
    writeFileSync(azStore, "{}");
    const res = await run(["up", "--yes", "--skip-preflight"], {
      env: {
        TENDB_FAKE_AZ_STORE: azStore,
        TENDB_FAKE_TF_STATE_SHOW: '    name = "kv-fake"\n',
      },
    });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("az keyvault secret set");
    // only the bootstrap ran — no full apply
    expect(tfCalls().map((c) => c.args[0])).toEqual(["init", "apply", "state"]);
  });
});

describe("tendb down", () => {
  it("destroys with --yes and leaves tendb.json alone", async () => {
    const before = readFileSync(join(dir, "tendb.json"), "utf8");
    const res = await run(["down", "--yes"]);
    expect(res.code).toBe(0);
    expect(tfCalls().map((c) => c.args)).toEqual([["destroy", "-input=false", "-auto-approve"]]);
    expect(readFileSync(join(dir, "tendb.json"), "utf8")).toBe(before);
  });

  it("refuses without --yes when non-interactive", async () => {
    const res = await run(["down"]);
    expect(res.code).toBe(2);
    expect(tfCalls()).toEqual([]);
  });
});
