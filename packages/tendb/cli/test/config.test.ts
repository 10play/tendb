import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";
import { UsageError } from "../src/errors.js";

function tempConfig(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "tendb-test-"));
  writeFileSync(join(dir, "tendb.json"), JSON.stringify(content));
  return dir;
}

const noEnv = {} as NodeJS.ProcessEnv;

describe("resolveConfig", () => {
  it("applies defaults with no sources", () => {
    const cfg = resolveConfig({ cwd: mkdtempSync(join(tmpdir(), "tendb-empty-")), processEnv: noEnv });
    expect(cfg.ssmPrefix).toBe("/tendb");
    expect(cfg.snapshotTimeoutSeconds).toBe(900);
    expect(cfg.cloneTimeoutSeconds).toBe(120);
  });

  it("finds tendb.json upward from cwd", () => {
    const dir = tempConfig({ ssmPrefix: "/from-file", database: "app" });
    const nested = join(dir, "a", "b");
    mkdirSync(nested, { recursive: true });
    const cfg = resolveConfig({ cwd: nested, processEnv: noEnv });
    expect(cfg.ssmPrefix).toBe("/from-file");
    expect(cfg.database).toBe("app");
  });

  it("surfaces deployDir and configPath without merging them into env layers", () => {
    const dir = tempConfig({ platform: "local", deployDir: "infra/tendb" });
    const cfg = resolveConfig({ cwd: dir, processEnv: noEnv });
    expect(cfg.deployDir).toBe("infra/tendb");
    expect(cfg.configPath).toBe(join(dir, "tendb.json"));
    expect(cfg.platform).toBe("local");
  });

  it("respects precedence: flags > env vars > file", () => {
    const dir = tempConfig({ ssmPrefix: "/from-file", region: "eu-west-1", database: "filedb" });
    const cfg = resolveConfig({
      cwd: dir,
      processEnv: { TENDB_REGION: "eu-north-1", TENDB_DATABASE: "envdb" } as NodeJS.ProcessEnv,
      flags: { region: "us-east-1" },
    });
    expect(cfg.region).toBe("us-east-1"); // flag wins
    expect(cfg.database).toBe("envdb"); // env beats file
    expect(cfg.ssmPrefix).toBe("/from-file"); // file survives
  });

  it("applies environment blocks over the top level", () => {
    const dir = tempConfig({
      ssmPrefix: "/top",
      environments: { staging: { ssmPrefix: "/staging" } },
    });
    const cfg = resolveConfig({ cwd: dir, processEnv: noEnv, flags: { env: "staging" } });
    expect(cfg.envName).toBe("staging");
    expect(cfg.ssmPrefix).toBe("/staging");
  });

  it("rejects unknown environments", () => {
    const dir = tempConfig({ environments: {} });
    expect(() => resolveConfig({ cwd: dir, processEnv: noEnv, flags: { env: "nope" } })).toThrow(UsageError);
  });

  it("rejects malformed config keys", () => {
    const dir = tempConfig({ ssmPrefix: "no-leading-slash" });
    expect(() => resolveConfig({ cwd: dir, processEnv: noEnv })).toThrow(UsageError);
  });
});
