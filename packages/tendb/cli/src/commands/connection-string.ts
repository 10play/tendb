import type { Command } from "commander";
import { normalizeBranchName } from "../naming.js";
import { getBranchClone } from "../dblab/workflows.js";
import { localizeUri, withSession } from "./shared.js";

export function registerConnectionString(program: Command): void {
  program
    .command("connection-string")
    .description("print a branch database connection URI (stdout only, neonctl-style)")
    .argument("<name>")
    .option("--local", "rewrite the host to 127.0.0.1 for use through an open tunnel (`tendb tunnel <name>`)")
    .action(async (rawName: string, opts: { local?: boolean }, cmd: Command) => {
      const name = normalizeBranchName(rawName);
      await withSession(cmd, async (session) => {
        const { clone, uri } = await getBranchClone(session, name);
        const out = opts.local ? localizeUri(uri, Number(clone.db?.port)) : uri;
        process.stdout.write(out + "\n");
      });
    });
}
