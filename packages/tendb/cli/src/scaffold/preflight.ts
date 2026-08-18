import { execFile, spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { DescribeSecretCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { fromIni } from "@aws-sdk/credential-providers";
import type { PlatformName, ResolvedConfig } from "../config.js";
import { MissingDependencyError, TenDBError } from "../errors.js";
import { progress } from "../output.js";
import { SOURCE_SECRET_PLACEHOLDER } from "./constants.js";
import { readTfvar } from "./terraform-cli.js";

/**
 * Checks that would otherwise surface as a clean `terraform apply` followed by
 * an engine that silently fails at boot (the source secret is read on-host).
 * Returns extra env for the terraform child (local: DOCKER_HOST).
 */
export async function runPreflight(
  platform: PlatformName,
  dir: string,
  cfg: ResolvedConfig,
): Promise<NodeJS.ProcessEnv> {
  switch (platform) {
    case "aws":
      await preflightAws(dir, cfg);
      return {};
    case "gcp":
      await preflightGcp(dir);
      return {};
    case "azure":
      await preflightAzure();
      return {};
    case "local":
      return preflightLocal(dir);
  }
}

async function preflightAws(dir: string, cfg: ResolvedConfig): Promise<void> {
  const arn = readTfvar(dir, "source_secret_arn");
  const name = readTfvar(dir, "name") ?? "tendb";
  const createHint =
    `create it, then put the ARN into ${join(dir, "terraform.tfvars")}:\n` +
    `  aws secretsmanager create-secret --name ${name}/source-url \\\n` +
    `    --secret-string 'postgres://user:pass@host:5432/dbname'`;
  if (!arn || arn === SOURCE_SECRET_PLACEHOLDER) {
    throw new TenDBError("source_secret_arn is not set in terraform.tfvars", 1, createHint);
  }
  const region = readTfvar(dir, "region") ?? cfg.region;
  const client = new SecretsManagerClient({
    ...(region ? { region } : {}),
    ...(cfg.profile ? { credentials: fromIni({ profile: cfg.profile }) } : {}),
  });
  try {
    await client.send(new DescribeSecretCommand({ SecretId: arn }));
    progress(`source secret ok: ${arn}`);
  } catch (err) {
    const e = err as Error & { name?: string };
    if (e.name === "ResourceNotFoundException") {
      throw new TenDBError(`source secret not found: ${arn}`, 1, createHint);
    }
    throw new TenDBError(
      `cannot verify the source secret: ${e.message}`,
      1,
      "check AWS credentials/region, or re-run with --skip-preflight",
    );
  } finally {
    client.destroy();
  }
}

const GCLOUD_HINT =
  "install the Google Cloud CLI and authenticate:\n" +
  "  macOS:  brew install --cask google-cloud-sdk\n" +
  "  then:   gcloud auth login";

export const AZ_HINT =
  "install the Azure CLI and authenticate:\n" +
  "  macOS:  brew install azure-cli\n" +
  "  then:   az login";

export function execTool(
  bin: string,
  args: string[],
  missingHint: string,
  input?: string,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(bin, args, { maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new MissingDependencyError(`${bin} not found on PATH`, missingHint));
        return;
      }
      resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr) });
    });
    if (input !== undefined) child.stdin?.end(input);
    else child.stdin?.end();
  });
}

async function preflightGcp(dir: string): Promise<void> {
  const secretId = readTfvar(dir, "source_secret_id");
  const project = readTfvar(dir, "project");
  if (!secretId || !project) return; // hand-edited tfvars — let terraform report
  const res = await execTool(
    "gcloud",
    ["secrets", "describe", secretId, "--project", project, "--quiet"],
    GCLOUD_HINT,
  );
  if (!res.ok) {
    throw new TenDBError(
      `source secret "${secretId}" not readable in project ${project}`,
      1,
      `create it:\n  printf '%s' 'postgres://user:pass@host:5432/dbname' | \\\n` +
        `    gcloud secrets create ${secretId} --project ${project} --data-file=-\n` +
        `(${res.stderr.trim().split("\n")[0] ?? ""})`,
    );
  }
  progress(`source secret ok: ${secretId}`);
}

/** The azure bootstrap (and tunnel) rides the az CLI — fail early if absent. */
async function preflightAzure(): Promise<void> {
  await execTool("az", ["version", "--output", "none"], AZ_HINT);
}

function preflightLocal(dir: string): Promise<NodeJS.ProcessEnv> {
  const script = join(dir, "scripts", "host-setup.sh");
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [script], { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new TenDBError(`host preflight failed (exit ${code})`, 1, `see ${script}`));
        return;
      }
      resolve(dockerHostEnv());
    });
  });
}

/** Terraform's docker provider needs the colima socket on macOS. */
export function dockerHostEnv(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (platform !== "darwin" || env.DOCKER_HOST) return {};
  const profile = env.TENDB_COLIMA_PROFILE ?? "default";
  return { DOCKER_HOST: `unix://${homedir()}/.colima/${profile}/docker.sock` };
}
