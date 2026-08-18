import type { Command } from "commander";
import { normalizeBranchName } from "../naming.js";
import { printJson, printTable, progress } from "../output.js";
import { deleteBranch, ensureBranch, getBranchClone, resetBranch } from "../dblab/workflows.js";
import { createSnapshotNow, snapshotSsm } from "../snapshots.js";
import { globalOpts, withSession, formatAge } from "./shared.js";
import type { Clone } from "../dblab/types.js";

function cloneRow(name: string, clone: Clone | undefined, dataStateAt?: string): string[] {
  return [
    name,
    clone ? clone.status.code : "-",
    clone?.db?.port !== undefined ? String(clone.db.port) : "-",
    dataStateAt ?? "-",
    formatAge(clone?.createdAt),
  ];
}

export function registerBranches(program: Command): void {
  const branches = program.command("branches").description("manage branch databases (DBLab branches + clones)");

  branches
    .command("create")
    .description("create (or reuse) a branch database; idempotent")
    .argument("<name>", "branch name (a bare number N becomes pr-N)")
    .option("--from <branch>", "base branch", "main")
    .option("--fresh", "snapshot the streaming sync target first (branch of main as-of-now)")
    .action(async (rawName: string, opts: { from: string; fresh?: boolean }, cmd: Command) => {
      const name = normalizeBranchName(rawName);
      await withSession(cmd, async (session) => {
        if (opts.fresh) {
          await createSnapshotNow(session.client, snapshotSsm(session.config, session.params), session.config.ssmPrefix);
        }
        const { clone, uri } = await ensureBranch(session, name, { from: opts.from });
        if (globalOpts(cmd).output === "json") {
          printJson({ name, state: clone.status.code, port: clone.db?.port, uri });
        } else {
          progress(`branch ${name} ready`);
          process.stdout.write(uri + "\n");
        }
      });
    });

  branches
    .command("list")
    .description("list branches and their clones")
    .action(async (_opts: unknown, cmd: Command) => {
      await withSession(cmd, async (session) => {
        const [list, status] = await Promise.all([session.client.listBranches(), session.client.status()]);
        const clones = status.cloning?.clones ?? [];
        const byId = new Map(clones.map((c) => [c.id, c]));
        const rows = list
          .filter((b) => b.name !== "main")
          .map((b) => cloneRow(b.name, byId.get(b.name), b.dataStateAt));
        if (globalOpts(cmd).output === "json") {
          printJson({ branches: list, clones });
        } else {
          printTable(["BRANCH", "STATE", "PORT", "DATA STATE AT", "AGE"], rows);
          progress(`${clones.length} clone(s) running`);
        }
      });
    });

  branches
    .command("get")
    .description("show one branch database")
    .argument("<name>")
    .action(async (rawName: string, _opts: unknown, cmd: Command) => {
      const name = normalizeBranchName(rawName);
      await withSession(cmd, async (session) => {
        const { clone, uri } = await getBranchClone(session, name);
        if (globalOpts(cmd).output === "json") {
          printJson({ name, state: clone.status.code, port: clone.db?.port, createdAt: clone.createdAt, uri });
        } else {
          printTable(["BRANCH", "STATE", "PORT", "DATA STATE AT", "AGE"], [cloneRow(name, clone)]);
          process.stdout.write(uri + "\n");
        }
      });
    });

  branches
    .command("delete")
    .description("delete a branch database (clone + branch; tolerates absent)")
    .argument("<name>")
    .action(async (rawName: string, _opts: unknown, cmd: Command) => {
      const name = normalizeBranchName(rawName);
      await withSession(cmd, async (session) => {
        await deleteBranch(session, name);
        if (globalOpts(cmd).output === "json") printJson({ name, deleted: true });
      });
    });

  branches
    .command("reset")
    .description("reset a branch database to its branch snapshot (recreates the clone)")
    .argument("<name>")
    .action(async (rawName: string, _opts: unknown, cmd: Command) => {
      const name = normalizeBranchName(rawName);
      await withSession(cmd, async (session) => {
        const { clone, uri } = await resetBranch(session, name);
        if (globalOpts(cmd).output === "json") {
          printJson({ name, state: clone.status.code, port: clone.db?.port, uri });
        } else {
          progress(`branch ${name} reset`);
          process.stdout.write(uri + "\n");
        }
      });
    });
}
