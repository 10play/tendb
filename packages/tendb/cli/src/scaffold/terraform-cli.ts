import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ResolvedConfig } from "../config.js";
import { MissingDependencyError, TenDBError, UsageError } from "../errors.js";
import { DEFAULT_SCAFFOLD_DIR, TERRAFORM_INSTALL_HINT } from "./constants.js";

export interface TerraformOpts {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

function missingTerraform(): MissingDependencyError {
  return new MissingDependencyError("terraform not found on PATH", TERRAFORM_INSTALL_HINT);
}

/** Run terraform interactively (stdio inherited — plans/prompts go to the user). */
export function runTerraform(args: string[], opts: TerraformOpts): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("terraform", args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: "inherit",
    });
    child.on("error", (err) => {
      reject((err as NodeJS.ErrnoException).code === "ENOENT" ? missingTerraform() : err);
    });
    child.on("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new TenDBError(`terraform ${args[0]} failed (${signal ?? `exit ${code}`})`));
    });
  });
}

/** Capture a terraform subcommand's stdout (for output/state reads). */
export function terraformCapture(args: string[], opts: TerraformOpts): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      "terraform",
      args,
      { cwd: opts.cwd, env: opts.env ?? process.env, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (!err) return resolvePromise(stdout);
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return reject(missingTerraform());
        reject(new TenDBError(`terraform ${args[0]} failed: ${stderr.trim() || err.message}`));
      },
    );
  });
}

export async function terraformOutputJson(
  opts: TerraformOpts,
): Promise<Record<string, { value: unknown }>> {
  const stdout = await terraformCapture(["output", "-json"], opts);
  try {
    return JSON.parse(stdout) as Record<string, { value: unknown }>;
  } catch {
    throw new TenDBError("terraform output -json produced unparseable output");
  }
}

/**
 * Scaffolded stacks use the local backend, so state sits next to main.tf.
 * "Has state" drives the azure two-phase bootstrap decision only.
 */
export function hasState(dir: string): boolean {
  const path = join(dir, "terraform.tfstate");
  if (!existsSync(path)) return false;
  try {
    const state = JSON.parse(readFileSync(path, "utf8")) as { resources?: unknown[] };
    return Array.isArray(state.resources) && state.resources.length > 0;
  } catch {
    return false;
  }
}

/**
 * Where `up`/`down` run terraform: --dir flag > deployDir from the located
 * tendb.json (relative to that file) > ./tendb when it holds a main.tf.
 */
export function resolveDeployDir(cfg: ResolvedConfig, dirFlag: string | undefined): string {
  if (dirFlag) {
    const dir = resolve(dirFlag);
    if (!existsSync(join(dir, "main.tf"))) {
      throw new UsageError(`no main.tf in ${dir}`, "run `tendb init` first");
    }
    return dir;
  }
  if (cfg.deployDir && cfg.configPath) {
    const dir = isAbsolute(cfg.deployDir)
      ? cfg.deployDir
      : resolve(dirname(cfg.configPath), cfg.deployDir);
    if (existsSync(join(dir, "main.tf"))) return dir;
  }
  const fallback = resolve(DEFAULT_SCAFFOLD_DIR);
  if (existsSync(join(fallback, "main.tf"))) return fallback;
  throw new UsageError(
    "no tendb terraform deployment found",
    "run `tendb init` first, or point at one with --dir",
  );
}

/** Read a scalar var from a generated terraform.tfvars (init writes k = "v" lines). */
export function readTfvar(dir: string, key: string): string | undefined {
  const path = join(dir, "terraform.tfvars");
  if (!existsSync(path)) return undefined;
  const match = readFileSync(path, "utf8").match(
    new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, "m"),
  );
  return match?.[1];
}
