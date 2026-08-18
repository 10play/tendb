import * as p from "@clack/prompts";
import type { Command } from "commander";
import { TenDBError, UsageError } from "../errors.js";
import { progress } from "../output.js";
import { dockerHostEnv } from "../scaffold/preflight.js";
import { resolveDeployDir, runTerraform } from "../scaffold/terraform-cli.js";
import { configFromCommand } from "./shared.js";

export function registerDown(program: Command): void {
  program
    .command("down")
    .description("terraform destroy the scaffolded deployment (tendb.json and state are kept)")
    .option("--dir <path>", "deployment directory (default: deployDir from tendb.json, else ./tendb)")
    .option("--yes", "skip the confirmation and auto-approve terraform")
    .action(async (opts: { dir?: string; yes?: boolean }, cmd: Command) => {
      const cfg = configFromCommand(cmd);
      const dir = resolveDeployDir(cfg, opts.dir);

      if (!opts.yes) {
        if (!process.stdin.isTTY) {
          throw new UsageError("refusing to destroy without --yes in non-interactive mode");
        }
        const confirmed = await p.confirm({
          message: `terraform destroy the ${cfg.platform} stack in ${dir}?`,
        });
        if (p.isCancel(confirmed) || !confirmed) throw new TenDBError("cancelled", 1);
      }

      const env =
        cfg.platform === "local" ? { ...process.env, ...dockerHostEnv() } : process.env;
      await runTerraform(
        opts.yes ? ["destroy", "-input=false", "-auto-approve"] : ["destroy"],
        { cwd: dir, env },
      );

      progress(`destroyed. kept: tendb.json, ${dir}/terraform.tfstate`);
      if (cfg.platform === "local") {
        progress("the colima VM is still running — `colima delete` reclaims it");
      }
    });
}
