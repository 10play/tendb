import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { PlatformName } from "../config.js";
import { TenDBError } from "../errors.js";
import { DEFAULT_MODULE_REF, GIT_MODULE_BASE } from "./constants.js";

export interface RenderOptions {
  /** Git ref for module sources (ignored when modulesSource is set). */
  ref?: string;
  /** Base path replacing the git source — for dev/CI/in-repo scaffolds. */
  modulesSource?: string;
}

/** `@tendb-modules/aws/engine` → git-pinned or local module source. */
export function moduleSourceFor(modulePath: string, opts: RenderOptions): string {
  if (opts.modulesSource) return `${opts.modulesSource.replace(/\/+$/, "")}/${modulePath}`;
  return `${GIT_MODULE_BASE}/${modulePath}?ref=${opts.ref ?? DEFAULT_MODULE_REF}`;
}

/**
 * Templates ship at the package root (files: ["dist", "templates"]). Walk up
 * from this module so the same code works from dist/index.js and from src/
 * under vitest.
 */
export function templatesRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, "templates");
    if (existsSync(join(candidate, "aws", "main.tf"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new TenDBError("templates directory not found — broken @10play/tendb install?");
    }
    dir = parent;
  }
}

function walk(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

/** npm pack strips `.gitignore`, so templates store it as `gitignore`. */
function outputName(rel: string): string {
  return rel === "gitignore" ? ".gitignore" : rel;
}

/** Relative output paths a scaffold owns (plus the generated terraform.tfvars). */
export function scaffoldOwnedFiles(platform: PlatformName): string[] {
  const files = walk(join(templatesRoot(), platform)).map(outputName);
  return [...files, "terraform.tfvars"];
}

/**
 * Copy the platform template into targetDir, substituting module sources in
 * .tf files. Returns the relative paths written.
 */
export function renderPlatformTemplate(
  platform: PlatformName,
  targetDir: string,
  opts: RenderOptions,
): string[] {
  // Terraform treats absolute module sources as copied "packages", breaking
  // the modules' internal ../ references — only ./ and ../ sources resolve
  // in place. Rebase an absolute modulesSource onto the deploy dir.
  if (opts.modulesSource && isAbsolute(opts.modulesSource)) {
    opts = { ...opts, modulesSource: relative(targetDir, opts.modulesSource).split(sep).join("/") };
  }
  const root = join(templatesRoot(), platform);
  const written: string[] = [];
  for (const rel of walk(root)) {
    const outRel = outputName(rel);
    const outPath = join(targetDir, outRel);
    mkdirSync(dirname(outPath), { recursive: true });
    let content = readFileSync(join(root, rel), "utf8");
    if (rel.endsWith(".tf")) {
      content = content.replace(/@tendb-modules\/([a-z0-9/_-]+)/g, (_m, p: string) =>
        moduleSourceFor(p, opts),
      );
    }
    writeFileSync(outPath, content);
    if (rel.endsWith(".sh")) chmodSync(outPath, 0o755);
    written.push(outRel);
  }
  return written;
}
