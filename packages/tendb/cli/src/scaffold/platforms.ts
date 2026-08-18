import { readFileSync } from "node:fs";
import type { ConfigFile, PlatformName } from "../config.js";
import { SOURCE_SECRET_PLACEHOLDER } from "./constants.js";

/**
 * One prompt with its non-interactive flag twin. `tendb init` walks these in
 * order; a flag answer suppresses the prompt, and `--yes`/non-TTY takes the
 * default (required questions without a default fail with the flag to pass).
 */
export interface Question {
  /** answers key AND the commander camelCase opts key. */
  key: string;
  /** kebab-case flag name (no dashes/value hint). */
  flag: string;
  valueHint: string;
  prompt: string;
  defaultValue?: string;
  /** Choices → rendered as a select. */
  select?: readonly string[];
  /** Must end up non-blank (no placeholder fallback). */
  required?: boolean;
  validate?: (v: string) => string | undefined;
  /** Post-prompt transform (e.g. read an ssh key file path). */
  normalize?: (v: string) => string;
}

export type Answers = Record<string, string>;

export interface PlatformSpec {
  platform: PlatformName;
  questions: Question[];
  /** terraform.tfvars content. */
  toTfvars(a: Answers): string;
  /** Initial tendb.json fields (deployDir added by the caller). */
  tendbJson(a: Answers): ConfigFile;
  /** Human next steps printed after scaffolding. */
  nextSteps(a: Answers, dir: string): string[];
}

const SIZES = ["small", "medium", "large", "xlarge"] as const;

const nameQuestion: Question = {
  key: "name",
  flag: "name",
  valueHint: "<name>",
  prompt: "Deployment name (resource prefix)",
  defaultValue: "tendb",
  validate: (v) => (/^[a-z][a-z0-9-]*$/.test(v) ? undefined : "lowercase letters, digits and dashes"),
};

const sizeQuestion: Question = {
  key: "size",
  flag: "size",
  valueHint: "<size>",
  prompt: "Size preset (source DB up to ~10G/50G/100G/1T)",
  defaultValue: "small",
  select: SIZES,
};

const pgVersion = (opts?: { defaultValue?: string }): Question => ({
  key: "pgVersion",
  flag: "pg-version",
  valueHint: "<major>",
  prompt: "Postgres MAJOR version of the source database (clone image must match)",
  ...opts,
  required: opts?.defaultValue === undefined,
  validate: (v) => (/^\d{2}$/.test(v) ? undefined : "a Postgres major like 16"),
});

/** key=value lines; numbers raw, strings JSON-quoted, undefined skipped. */
function tfvars(entries: Array<[string, string | number | undefined]>): string {
  return (
    entries
      .filter((e): e is [string, string | number] => e[1] !== undefined)
      .map(([k, v]) => `${k} = ${typeof v === "number" ? v : JSON.stringify(v)}`)
      .join("\n") + "\n"
  );
}

const blank = (v: string | undefined): string | undefined => (v === "" ? undefined : v);

const aws: PlatformSpec = {
  platform: "aws",
  questions: [
    nameQuestion,
    {
      key: "region",
      flag: "region", // global flag twin
      valueHint: "<region>",
      prompt: "AWS region",
      defaultValue: "eu-north-1",
    },
    pgVersion(),
    {
      key: "sourceSecretArn",
      flag: "source-secret-arn",
      valueHint: "<arn>",
      prompt: "Secrets Manager ARN holding the source Postgres URL (blank → fill in later)",
      defaultValue: "",
    },
    sizeQuestion,
  ],
  toTfvars: (a) =>
    tfvars([
      ["name", a.name],
      ["region", a.region],
      ["size", a.size],
      ["postgres_major_version", Number(a.pgVersion)],
      ["source_secret_arn", blank(a.sourceSecretArn) ?? SOURCE_SECRET_PLACEHOLDER],
    ]),
  tendbJson: (a) => ({ platform: "aws", ssmPrefix: `/${a.name}`, region: a.region! }),
  nextSteps: (a, dir) => [
    ...(blank(a.sourceSecretArn)
      ? []
      : [
          `create the source secret (the URL must never land in terraform state):\n` +
            `      aws secretsmanager create-secret --name ${a.name}/source-url \\\n` +
            `        --secret-string 'postgres://user:pass@host:5432/dbname'\n` +
            `    then put its ARN into ${dir}/terraform.tfvars (source_secret_arn)`,
        ]),
    "run `tendb up` — terraform provisions the network + engine host (~5 min)",
    "wait for the first sync, then: tendb status && tendb branches create my-feature",
    "CI/teammates need AWS credentials with the client_iam_policy_arn output attached, plus session-manager-plugin",
  ],
};

const gcp: PlatformSpec = {
  platform: "gcp",
  questions: [
    nameQuestion,
    { key: "project", flag: "project", valueHint: "<id>", prompt: "GCP project id", required: true },
    {
      key: "region",
      flag: "region", // global flag twin
      valueHint: "<region>",
      prompt: "GCP region",
      defaultValue: "us-central1",
    },
    { key: "zone", flag: "zone", valueHint: "<zone>", prompt: "GCP zone", defaultValue: "us-central1-a" },
    pgVersion(),
    {
      key: "sourceSecretId",
      flag: "source-secret-id",
      valueHint: "<id>",
      prompt: "Secret Manager secret id holding the source Postgres URL",
      defaultValue: "tendb-source-url",
    },
    sizeQuestion,
  ],
  toTfvars: (a) =>
    tfvars([
      ["project", a.project],
      ["region", a.region],
      ["zone", a.zone],
      ["name", a.name],
      ["size", a.size],
      ["postgres_major_version", Number(a.pgVersion)],
      ["source_secret_id", a.sourceSecretId],
    ]),
  tendbJson: (a) => ({ platform: "gcp", paramPrefix: `/${a.name}`, gcpProject: a.project! }),
  nextSteps: (a, dir) => [
    `create the source secret (out of band, never in terraform state):\n` +
      `      printf '%s' 'postgres://user:pass@host:5432/dbname' | \\\n` +
      `        gcloud secrets create ${a.sourceSecretId} --project ${a.project} --data-file=-`,
    "authenticate terraform: gcloud auth application-default login",
    "run `tendb up`, then: tendb status && tendb branches create my-feature",
    `clients need roles/iap.tunnelResourceAccessor — see the client_iam_snippet output in ${dir}`,
  ],
};

const azure: PlatformSpec = {
  platform: "azure",
  questions: [
    nameQuestion,
    {
      key: "location",
      flag: "location",
      valueHint: "<location>",
      prompt: "Azure location",
      defaultValue: "northeurope",
    },
    {
      key: "subscriptionId",
      flag: "subscription-id",
      valueHint: "<id>",
      prompt: "Subscription id (blank → ARM_SUBSCRIPTION_ID)",
      defaultValue: "",
    },
    pgVersion(),
    {
      key: "sshPublicKey",
      flag: "ssh-public-key",
      valueHint: "<path|key>",
      prompt: "SSH public key for the VMs (path or literal)",
      defaultValue: "~/.ssh/id_ed25519.pub",
      normalize: readKeyMaterial,
    },
    {
      key: "sourceSecretName",
      flag: "source-secret-name",
      valueHint: "<name>",
      prompt: "Key Vault secret name for the source Postgres URL",
      defaultValue: "tendb-source-url",
    },
    sizeQuestion,
  ],
  toTfvars: (a) =>
    tfvars([
      ["subscription_id", blank(a.subscriptionId)],
      ["location", a.location],
      ["name", a.name],
      ["size", a.size],
      ["postgres_major_version", Number(a.pgVersion)],
      ["admin_ssh_public_key", a.sshPublicKey],
      ["source_secret_name", a.sourceSecretName],
    ]),
  tendbJson: () => ({ platform: "azure" }),
  nextSteps: (a) => [
    "authenticate terraform: az login" +
      (blank(a.subscriptionId) ? "" : " (or export ARM_SUBSCRIPTION_ID)"),
    "run `tendb up` — the first apply is two-phase (vault first, then the source secret, then everything); `up` walks you through it",
    "note: the Bastion Standard tunnel costs ~$140/mo idle",
    "then: tendb status && tendb branches create my-feature",
  ],
};

const local: PlatformSpec = {
  platform: "local",
  questions: [
    nameQuestion,
    pgVersion({ defaultValue: "16" }),
    {
      key: "sourceUrl",
      flag: "source-url",
      valueHint: "<url>",
      prompt: "Source Postgres URL as reachable from the docker host (blank → seeded demo source)",
      defaultValue: "",
    },
    {
      key: "stateDir",
      flag: "state-dir",
      valueHint: "<path>",
      prompt: "State dir for params.json (blank → ~/.tendb/local)",
      defaultValue: "",
    },
    sizeQuestion,
  ],
  toTfvars: (a) =>
    tfvars([
      ["name", a.name],
      ["size", a.size],
      // The local example types this as a string (docker image tag half).
      ["postgres_major_version", a.pgVersion],
      ["source_url", blank(a.sourceUrl)],
      ["state_dir", blank(a.stateDir)],
    ]),
  tendbJson: (a) => ({
    platform: "local",
    ...(blank(a.stateDir) ? { stateDir: a.stateDir! } : {}),
  }),
  nextSteps: () => [
    "run `tendb up` — it runs the ZFS/colima preflight (macOS installs colima via brew) then terraform",
    "Docker Desktop will NOT work on macOS (no ZFS kernel module) — `up` uses a colima VM instead",
    "after the first sync (~1 min for the demo source): tendb status && tendb branches create my-feature",
  ],
};

export const PLATFORM_SPECS: Record<PlatformName, PlatformSpec> = { aws, gcp, azure, local };

/** Accept a public key literally or as a path to read (with ~ expansion). */
function readKeyMaterial(v: string): string {
  if (v.startsWith("ssh-") || v.startsWith("ecdsa-")) return v.trim();
  const path = v.startsWith("~/") ? `${process.env.HOME}/${v.slice(2)}` : v;
  return readFileSync(path, "utf8").trim();
}
