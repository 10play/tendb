import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import { PLATFORMS, type PlatformName } from "../config.js";
import { TenDBError, UsageError } from "../errors.js";
import { progress, setQuiet } from "../output.js";
import { DEFAULT_SCAFFOLD_DIR } from "../scaffold/constants.js";
import { PLATFORM_SPECS, type Answers, type Question } from "../scaffold/platforms.js";
import { createOrMergeTendbJson } from "../scaffold/tendb-json.js";
import { renderPlatformTemplate } from "../scaffold/templates.js";

interface InitOpts {
  dir?: string;
  ref?: string;
  modulesSource?: string;
  force?: boolean;
  yes?: boolean;
  platform?: string;
  quiet?: boolean;
  [key: string]: unknown;
}

export function registerInit(program: Command): void {
  const cmd = program
    .command("init")
    .description("scaffold a terraform deployment + tendb.json into this project")
    .option("--dir <path>", `deployment directory (default ./${DEFAULT_SCAFFOLD_DIR})`)
    .option("--ref <git-ref>", "tendb module version to pin in terraform sources")
    .option("--modules-source <base>", "use a local terraform modules path instead of git (dev/CI)")
    .option("--force", "overwrite scaffold-owned files and retarget an existing tendb.json")
    .option("--yes", "non-interactive: accept defaults, require flags for the rest");

  // Every prompt has a flag twin (deduped across platforms; --platform and
  // --region ride the global option set).
  const seen = new Set(["region"]);
  for (const spec of Object.values(PLATFORM_SPECS)) {
    for (const q of spec.questions) {
      if (seen.has(q.flag)) continue;
      seen.add(q.flag);
      cmd.option(`--${q.flag} ${q.valueHint}`, q.prompt);
    }
  }

  cmd.action(async (_opts, actionCmd: Command) => {
    const opts = actionCmd.optsWithGlobals() as InitOpts;
    setQuiet(Boolean(opts.quiet));
    await runInit(opts);
  });
}

async function runInit(opts: InitOpts): Promise<void> {
  const interactive =
    !opts.yes && Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);

  if (interactive) p.intro("tendb init");
  const platform = await pickPlatform(opts, interactive);
  const spec = PLATFORM_SPECS[platform];
  const answers = await collectAnswers(spec.questions, opts, interactive);
  if (interactive) p.outro("scaffolding…");

  const dir = resolve(opts.dir ?? DEFAULT_SCAFFOLD_DIR);
  if (existsSync(dir) && readdirSync(dir).length > 0 && !opts.force) {
    throw new UsageError(
      `${dir} already exists and is not empty`,
      "re-run with --force to overwrite the scaffold-owned files (terraform state and foreign files are never deleted)",
    );
  }

  const written = renderPlatformTemplate(platform, dir, {
    ref: opts.ref,
    modulesSource: opts.modulesSource,
  });
  writeFileSync(join(dir, "terraform.tfvars"), spec.toTfvars(answers));
  written.push("terraform.tfvars");
  for (const rel of written.sort()) progress(`  ${join(dir, rel)}`);

  const configPath = resolve("tendb.json");
  const deployDir = relative(process.cwd(), dir) || ".";
  const action = createOrMergeTendbJson(
    configPath,
    { ...spec.tendbJson(answers), deployDir },
    { force: opts.force },
  );
  progress(`  ${configPath} (${action})`);

  const steps = spec.nextSteps(answers, deployDir);
  process.stdout.write(
    `\nscaffolded a ${platform} deployment in ${deployDir}/\n\nnext steps:\n` +
      steps.map((s, i) => `  ${i + 1}. ${s}`).join("\n") +
      "\n",
  );
}

async function pickPlatform(opts: InitOpts, interactive: boolean): Promise<PlatformName> {
  if (opts.platform !== undefined) {
    if (!(PLATFORMS as readonly string[]).includes(opts.platform)) {
      throw new UsageError(`invalid --platform "${opts.platform}"`, `expected one of: ${PLATFORMS.join(", ")}`);
    }
    return opts.platform as PlatformName;
  }
  if (!interactive) return "aws";
  const picked = await p.select({
    message: "Where should the branching engine run?",
    options: [
      { value: "aws" as PlatformName, label: "aws", hint: "EC2 + SSM (production-ready)" },
      { value: "local" as PlatformName, label: "local", hint: "Docker on this machine, no cloud account" },
      { value: "gcp" as PlatformName, label: "gcp", hint: "Compute Engine + IAP (validate-only)" },
      { value: "azure" as PlatformName, label: "azure", hint: "VM + Bastion (validate-only)" },
    ],
  });
  if (p.isCancel(picked)) throw new TenDBError("cancelled", 1);
  return picked;
}

async function collectAnswers(
  questions: Question[],
  opts: InitOpts,
  interactive: boolean,
): Promise<Answers> {
  const answers: Answers = {};
  const missing: string[] = [];
  for (const q of questions) {
    let value = opts[q.key] as string | undefined;
    if (value === undefined) {
      if (interactive) value = await ask(q);
      else if (q.defaultValue !== undefined) value = q.defaultValue;
      else {
        missing.push(`--${q.flag}`);
        continue;
      }
    }
    if (value !== "") {
      const err = q.validate?.(value);
      if (err) throw new UsageError(`invalid --${q.flag} "${value}": ${err}`);
    } else if (q.required) {
      missing.push(`--${q.flag}`);
      continue;
    }
    answers[q.key] = q.normalize && value !== "" ? q.normalize(value) : value;
  }
  if (missing.length > 0) {
    throw new UsageError(
      `missing required answers: ${missing.join(", ")}`,
      "pass them as flags, or run without --yes for prompts",
    );
  }
  return answers;
}

async function ask(q: Question): Promise<string> {
  if (q.select) {
    const picked = await p.select({
      message: q.prompt,
      options: q.select.map((value) => ({ value, label: value })),
      initialValue: q.defaultValue,
    });
    if (p.isCancel(picked)) throw new TenDBError("cancelled", 1);
    return picked;
  }
  const typed = await p.text({
    message: q.prompt,
    initialValue: q.defaultValue,
    validate: (v) => (v ? q.validate?.(v) : q.required ? "required" : undefined),
  });
  if (p.isCancel(typed)) throw new TenDBError("cancelled", 1);
  return typed ?? "";
}
