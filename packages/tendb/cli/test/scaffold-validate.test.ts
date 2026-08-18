import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * Real `terraform validate` on scaffolded output — network-dependent
 * (provider downloads), so gated for the dedicated CI job:
 *   TENDB_SCAFFOLD_VALIDATE=1 vitest run test/scaffold-validate.test.ts
 */
const enabled = Boolean(process.env.TENDB_SCAFFOLD_VALIDATE);

const cliDir = fileURLToPath(new URL("..", import.meta.url));
const binary = join(cliDir, "dist", "index.js");
const modulesAbs = join(cliDir, "..", "terraform", "modules");
const exampleDeployDir = join(cliDir, "..", "..", "..", "apps", "example", "tendb");

const INIT_FLAGS: Record<string, string[]> = {
  aws: ["--region", "eu-west-1", "--pg-version", "16", "--source-secret-arn", "arn:aws:secretsmanager:eu-west-1:1:secret:x"],
  gcp: ["--project", "validate-only", "--region", "us-central1", "--zone", "us-central1-a", "--pg-version", "16"],
  azure: ["--pg-version", "16", "--ssh-public-key", "ssh-ed25519 AAAA validate"],
  local: [],
};

function scaffold(platform: string, cwd: string, extra: string[] = []): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      process.execPath,
      [binary, "init", "--platform", platform, "--yes", ...INIT_FLAGS[platform]!, ...extra],
      { cwd, env: { ...process.env, TENDB_CONFIG: "" } },
      (err, _stdout, stderr) => (err ? reject(new Error(stderr)) : resolvePromise()),
    );
  });
}

function terraform(args: string[], cwd: string): void {
  execFileSync("terraform", args, { cwd, stdio: "inherit" });
}

describe.skipIf(!enabled)("terraform validate on scaffolded output", () => {
  beforeAll(() => {
    if (!existsSync(binary)) {
      execFileSync("pnpm", ["build:cli"], { cwd: cliDir, stdio: "inherit" });
    }
  });

  for (const platform of ["aws", "gcp", "azure", "local"] as const) {
    it(`${platform} scaffold validates against this checkout's modules`, { timeout: 600_000 }, async () => {
      const dir = mkdtempSync(join(tmpdir(), `tendb-validate-${platform}-`));
      try {
        await scaffold(platform, dir, ["--modules-source", modulesAbs]);
        const deployDir = join(dir, "tendb");
        terraform(["init", "-backend=false", "-input=false"], deployDir);
        terraform(["validate"], deployDir);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it("git-pinned sources render without leftover tokens", { timeout: 600_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "tendb-validate-git-"));
    try {
      await scaffold("aws", dir, ["--ref", "v0.0.0"]);
      const main = readFileSync(join(dir, "tendb", "main.tf"), "utf8");
      expect(main).toContain("git::https://github.com/10play/tendb.git//packages/tendb/terraform/modules/aws/network?ref=v0.0.0");
      expect(main).not.toContain("@tendb-modules");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!enabled)("apps/example/tendb", () => {
  it("is exactly what the scaffolder emits (run apps/example scripts/scaffold.mjs on drift)", { timeout: 600_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "tendb-example-drift-"));
    try {
      await scaffold("local", dir, ["--modules-source", "../../../packages/tendb/terraform/modules"]);
      const regen = join(dir, "tendb");
      const generated = readdirSync(regen, { recursive: true }) as string[];
      for (const rel of generated) {
        const regenPath = join(regen, rel);
        const committedPath = join(exampleDeployDir, rel);
        if (readdirSyncSafeIsDir(regenPath)) continue;
        expect(existsSync(committedPath), `${rel} missing from apps/example/tendb`).toBe(true);
        expect(readFileSync(committedPath, "utf8"), `${rel} drifted`).toBe(readFileSync(regenPath, "utf8"));
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("validates against this checkout's modules", { timeout: 600_000 }, () => {
    terraform(["init", "-backend=false", "-input=false"], exampleDeployDir);
    terraform(["validate"], exampleDeployDir);
  });
});

function readdirSyncSafeIsDir(path: string): boolean {
  try {
    readdirSync(path);
    return true;
  } catch {
    return false;
  }
}
