import { resolve } from "node:path";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import { TenDBError } from "../errors.js";
import { progress } from "../output.js";
import { AZURE_BOOTSTRAP_TARGETS } from "../scaffold/constants.js";
import { AZ_HINT, dockerHostEnv, execTool, runPreflight } from "../scaffold/preflight.js";
import { mergeDiscovery, parseDiscovery } from "../scaffold/tendb-json.js";
import {
  hasState,
  readTfvar,
  resolveDeployDir,
  runTerraform,
  terraformCapture,
  terraformOutputJson,
} from "../scaffold/terraform-cli.js";
import { configFromCommand } from "./shared.js";

interface UpOpts {
  dir?: string;
  yes?: boolean;
  skipPreflight?: boolean;
  init: boolean;
}

export function registerUp(program: Command): void {
  program
    .command("up")
    .description("terraform init+apply the scaffolded deployment, then wire tendb.json from its outputs")
    .option("--dir <path>", "deployment directory (default: deployDir from tendb.json, else ./tendb)")
    .option("--yes", "auto-approve terraform (and the azure bootstrap prompts)")
    .option("--skip-preflight", "skip the source-secret / docker-host checks")
    .option("--no-init", "skip terraform init")
    .action(async (opts: UpOpts, cmd: Command) => {
      const cfg = configFromCommand(cmd);
      const dir = resolveDeployDir(cfg, opts.dir);
      const platform = cfg.platform;
      progress(`platform ${platform} · ${dir}`);

      let extraEnv: NodeJS.ProcessEnv = platform === "local" ? dockerHostEnv() : {};
      if (!opts.skipPreflight) {
        extraEnv = { ...extraEnv, ...(await runPreflight(platform, dir, cfg)) };
      }
      const env = { ...process.env, ...extraEnv };

      if (opts.init) await runTerraform(["init", "-input=false"], { cwd: dir, env });
      if (platform === "azure" && !hasState(dir)) {
        await azureBootstrap(dir, env, Boolean(opts.yes));
      }
      await runTerraform(
        opts.yes ? ["apply", "-input=false", "-auto-approve"] : ["apply"],
        { cwd: dir, env },
      );

      const outputs = await terraformOutputJson({ cwd: dir, env });
      const discovery = parseDiscovery(outputs.cli_discovery?.value);
      const configPath = cfg.configPath ?? resolve("tendb.json");
      mergeDiscovery(configPath, discovery, cfg.envName);
      progress(`updated ${configPath}${cfg.envName ? ` (environments.${cfg.envName})` : ""}`);

      process.stdout.write(
        "\nthe platform is up. once the first sync finishes:\n" +
          "  tendb status\n  tendb branches create my-feature\n  tendb psql my-feature\n",
      );
    });
}

/**
 * First azure apply is two-phase: the source secret lives in the Key Vault
 * this stack creates, so the vault (and the deployer's secrets role) must
 * exist before the secret can be set and the engine can read it.
 */
async function azureBootstrap(dir: string, env: NodeJS.ProcessEnv, yes: boolean): Promise<void> {
  progress("first apply on azure: bootstrapping the Key Vault before the engine");
  const targets = AZURE_BOOTSTRAP_TARGETS.map((t) => `-target=${t}`);
  await runTerraform(
    yes ? ["apply", "-input=false", "-auto-approve", ...targets] : ["apply", ...targets],
    { cwd: dir, env },
  );

  const vault = await vaultName(dir, env);
  const secretName = readTfvar(dir, "source_secret_name") ?? "tendb-source-url";
  const setCommand =
    `printf '%s' 'postgres://user:pass@host:5432/dbname' | \\\n` +
    `    az keyvault secret set --vault-name ${vault} --name ${secretName} --file /dev/stdin`;

  const existing = await execTool(
    "az",
    ["keyvault", "secret", "show", "--vault-name", vault, "--name", secretName, "--output", "none"],
    AZ_HINT,
  );
  if (existing.ok) {
    progress(`source secret ${secretName} already set in ${vault}`);
    return;
  }
  if (yes || !process.stdin.isTTY) {
    throw new TenDBError(
      `the source secret is not set in Key Vault ${vault}`,
      1,
      `set it, then re-run tendb up:\n  ${setCommand}`,
    );
  }
  const url = await p.password({
    message: `Source Postgres URL (stored as Key Vault secret ${secretName})`,
  });
  if (p.isCancel(url) || !url) {
    throw new TenDBError("cancelled", 1, `set the secret manually, then re-run tendb up:\n  ${setCommand}`);
  }
  // --file /dev/stdin keeps the URL out of argv (same trick as the azure adapter).
  const set = await execTool(
    "az",
    ["keyvault", "secret", "set", "--vault-name", vault, "--name", secretName, "--file", "/dev/stdin", "--output", "none"],
    AZ_HINT,
    url,
  );
  if (!set.ok) {
    throw new TenDBError(
      `az keyvault secret set failed: ${set.stderr.trim().split("\n")[0] ?? ""}`,
      1,
      `set it manually, then re-run tendb up:\n  ${setCommand}`,
    );
  }
  progress(`source secret ${secretName} stored in ${vault}`);
}

/** Targeted applies don't record outputs, so read the vault name off the state. */
async function vaultName(dir: string, env: NodeJS.ProcessEnv): Promise<string> {
  const shown = await terraformCapture(
    ["state", "show", "-no-color", AZURE_BOOTSTRAP_TARGETS[0]],
    { cwd: dir, env },
  );
  const match = shown.match(/^\s*name\s*=\s*"([^"]+)"/m);
  if (!match) throw new TenDBError("could not read the Key Vault name from terraform state");
  return match[1]!;
}
