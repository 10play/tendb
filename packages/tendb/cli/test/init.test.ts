import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PLATFORM_SPECS } from "../src/scaffold/platforms.js";
import { renderPlatformTemplate, scaffoldOwnedFiles } from "../src/scaffold/templates.js";
import { createOrMergeTendbJson, parseDiscovery } from "../src/scaffold/tendb-json.js";
import { SOURCE_SECRET_PLACEHOLDER } from "../src/scaffold/constants.js";
import { UsageError } from "../src/errors.js";

const cliDir = fileURLToPath(new URL("..", import.meta.url));
const binary = join(cliDir, "dist", "index.js");
const terraformTree = join(cliDir, "..", "terraform");

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tendb-init-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("renderPlatformTemplate", () => {
  it("pins module sources to the git ref and leaves no tokens behind", () => {
    renderPlatformTemplate("aws", dir, { ref: "v1.2.3" });
    const main = readFileSync(join(dir, "main.tf"), "utf8");
    expect(main).toContain(
      'source = "git::https://github.com/10play/tendb.git//packages/tendb/terraform/modules/aws/engine?ref=v1.2.3"',
    );
    expect(main).not.toContain("@tendb-modules");
  });

  it("substitutes a local modules source instead when given", () => {
    renderPlatformTemplate("local", dir, { modulesSource: "../../modules" });
    const main = readFileSync(join(dir, "main.tf"), "utf8");
    expect(main).toContain('source = "../../modules/local/engine"');
    expect(main).not.toContain("git::");
  });

  it("renames gitignore and marks host-setup.sh executable", () => {
    renderPlatformTemplate("local", dir, {});
    expect(existsSync(join(dir, ".gitignore"))).toBe(true);
    expect(existsSync(join(dir, "gitignore"))).toBe(false);
    expect(existsSync(join(dir, "seed", "seed.sql"))).toBe(true);
    const mode = statSync(join(dir, "scripts", "host-setup.sh")).mode;
    expect(mode & 0o100).toBeTruthy();
  });

  it("owns terraform.tfvars in every platform's file list", () => {
    for (const platform of ["aws", "gcp", "azure", "local"] as const) {
      expect(scaffoldOwnedFiles(platform)).toContain("terraform.tfvars");
      expect(scaffoldOwnedFiles(platform)).toContain(".gitignore");
    }
  });
});

describe("tfvars generation", () => {
  it("aws: quotes strings, leaves numbers raw, placeholders a blank secret", () => {
    const tfvars = PLATFORM_SPECS.aws.toTfvars({
      name: "acme",
      region: "eu-west-1",
      size: "small",
      pgVersion: "17",
      sourceSecretArn: "",
    });
    expect(tfvars).toContain('name = "acme"');
    expect(tfvars).toContain("postgres_major_version = 17");
    expect(tfvars).toContain(`source_secret_arn = "${SOURCE_SECRET_PLACEHOLDER}"`);
  });

  it("local: keeps the pg major a string and omits blank optionals", () => {
    const tfvars = PLATFORM_SPECS.local.toTfvars({
      name: "tendb",
      size: "small",
      pgVersion: "16",
      sourceUrl: "",
      stateDir: "",
    });
    expect(tfvars).toContain('postgres_major_version = "16"');
    expect(tfvars).not.toContain("source_url");
    expect(tfvars).not.toContain("state_dir");
  });

  it("azure: omits a blank subscription id", () => {
    const tfvars = PLATFORM_SPECS.azure.toTfvars({
      name: "tendb",
      location: "northeurope",
      subscriptionId: "",
      size: "small",
      pgVersion: "16",
      sshPublicKey: "ssh-ed25519 AAAA test",
      sourceSecretName: "tendb-source-url",
    });
    expect(tfvars).not.toContain("subscription_id");
    expect(tfvars).toContain('admin_ssh_public_key = "ssh-ed25519 AAAA test"');
  });
});

describe("createOrMergeTendbJson", () => {
  it("creates when absent, merges keeping user keys, repoints deployDir", () => {
    const path = join(dir, "tendb.json");
    expect(
      createOrMergeTendbJson(path, { platform: "local", deployDir: "tendb" }),
    ).toBe("created");

    writeFileSync(path, JSON.stringify({ platform: "local", database: "appdb", deployDir: "old" }));
    expect(
      createOrMergeTendbJson(path, { platform: "local", deployDir: "infra" }),
    ).toBe("merged");
    const merged = JSON.parse(readFileSync(path, "utf8"));
    expect(merged.database).toBe("appdb");
    expect(merged.deployDir).toBe("infra");
  });

  it("refuses a platform switch without --force", () => {
    const path = join(dir, "tendb.json");
    writeFileSync(path, JSON.stringify({ platform: "aws" }));
    expect(() =>
      createOrMergeTendbJson(path, { platform: "local", deployDir: "tendb" }),
    ).toThrow(UsageError);
    createOrMergeTendbJson(path, { platform: "local", deployDir: "tendb" }, { force: true });
    expect(JSON.parse(readFileSync(path, "utf8")).platform).toBe("local");
  });
});

describe("parseDiscovery", () => {
  it("parses the JSON string and strips nulls/unknowns", () => {
    const d = parseDiscovery(
      JSON.stringify({ platform: "gcp", paramPrefix: "/tendb", gcpProject: "p", region: null, bogus: 1 }),
    );
    expect(d).toEqual({ platform: "gcp", paramPrefix: "/tendb", gcpProject: "p" });
  });

  it("rejects non-strings and wrong shapes", () => {
    expect(() => parseDiscovery(undefined)).toThrow(/missing/);
    expect(() => parseDiscovery('{"platform":"mars"}')).toThrow(/unexpected/);
  });
});

describe("template drift vs the terraform tree", () => {
  it("host-setup.sh and seed.sql are byte-identical to their originals", () => {
    const pairs = [
      ["templates/local/scripts/host-setup.sh", "modules/local/scripts/host-setup.sh"],
      ["templates/local/seed/seed.sql", "examples/local/seed/seed.sql"],
    ];
    for (const [tpl, orig] of pairs) {
      expect(readFileSync(join(cliDir, tpl!), "utf8")).toBe(
        readFileSync(join(terraformTree, orig!), "utf8"),
      );
    }
  });
});

describe("tendb init (built binary)", () => {
  beforeAll(() => {
    if (!existsSync(binary)) {
      execFileSync("pnpm", ["build:cli"], { cwd: cliDir, stdio: "inherit" });
    }
  });

  function run(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolveRun) => {
      execFile(
        process.execPath,
        [binary, ...args],
        { cwd, env: { ...process.env, TENDB_CONFIG: "" } },
        (err, stdout, stderr) => {
          resolveRun({ code: (err as { code?: number } | null)?.code ?? 0, stdout, stderr });
        },
      );
    });
  }

  it("--yes fails listing the flags that have no default", async () => {
    const res = await run(["init", "--platform", "aws", "--yes"], dir);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("--pg-version");
  });

  it("scaffolds local with defaults and writes tendb.json", async () => {
    const res = await run(["init", "--platform", "local", "--yes"], dir);
    expect(res.code).toBe(0);
    expect(existsSync(join(dir, "tendb", "main.tf"))).toBe(true);
    expect(existsSync(join(dir, "tendb", "scripts", "host-setup.sh"))).toBe(true);
    const config = JSON.parse(readFileSync(join(dir, "tendb.json"), "utf8"));
    expect(config).toEqual({ platform: "local", deployDir: "tendb" });
    expect(res.stdout).toContain("next steps");
  });

  it("refuses a non-empty target dir without --force, allows it with", async () => {
    await run(["init", "--platform", "local", "--yes"], dir);
    const refused = await run(["init", "--platform", "local", "--yes"], dir);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain("--force");

    writeFileSync(join(dir, "tendb", "terraform.tfstate"), "{}");
    const forced = await run(["init", "--platform", "local", "--yes", "--force"], dir);
    expect(forced.code).toBe(0);
    // --force overwrites scaffold-owned files but never deletes foreign ones
    expect(existsSync(join(dir, "tendb", "terraform.tfstate"))).toBe(true);
  });

  it("scaffolds aws with flags, pinning the ref", async () => {
    const res = await run(
      [
        "init", "--platform", "aws", "--yes",
        "--region", "eu-west-1", "--pg-version", "16",
        "--source-secret-arn", "arn:aws:secretsmanager:eu-west-1:1:secret:x",
        "--ref", "v9.9.9",
      ],
      dir,
    );
    expect(res.code).toBe(0);
    const main = readFileSync(join(dir, "tendb", "main.tf"), "utf8");
    expect(main).toContain("?ref=v9.9.9");
    const tfvars = readFileSync(join(dir, "tendb", "terraform.tfvars"), "utf8");
    expect(tfvars).toContain('region = "eu-west-1"');
    const config = JSON.parse(readFileSync(join(dir, "tendb.json"), "utf8"));
    expect(config).toEqual({
      platform: "aws",
      ssmPrefix: "/tendb",
      region: "eu-west-1",
      deployDir: "tendb",
    });
  });
});
