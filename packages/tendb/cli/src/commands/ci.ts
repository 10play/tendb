import type { Command } from "commander";
import { PlatformDownError } from "../errors.js";
import { normalizeBranchName } from "../naming.js";
import { progress } from "../output.js";
import { deleteBranch, ensureBranch, getBranchClone } from "../dblab/workflows.js";
import { withSession } from "./shared.js";

/**
 * Machine contract (drop-in for the legacy dblab-branch.sh / neon-branch.sh):
 *   - the connection URI is the LAST line on stdout; everything else → stderr
 *   - a bare number N means branch pr-N
 *   - `ci delete` exits 0 when the platform is down (nothing left to delete)
 * Do not add stdout chatter here.
 */
export function registerCi(program: Command): void {
  const ci = program.command("ci").description("script-friendly verbs with the URI-last-line contract");

  ci.command("ensure")
    .description("branch + clone exist and are ready; URI on the last stdout line")
    .argument("<id>", "PR number or branch name")
    .action(async (id: string, _opts: unknown, cmd: Command) => {
      const name = normalizeBranchName(id);
      await withSession(cmd, async (session) => {
        const { uri } = await ensureBranch(session, name);
        process.stdout.write(uri + "\n");
      });
    });

  ci.command("url")
    .description("URI of an existing branch database (last stdout line)")
    .argument("<id>")
    .action(async (id: string, _opts: unknown, cmd: Command) => {
      const name = normalizeBranchName(id);
      await withSession(cmd, async (session) => {
        const { uri } = await getBranchClone(session, name);
        process.stdout.write(uri + "\n");
      });
    });

  ci.command("delete")
    .description("delete branch database; exits 0 when absent or platform down")
    .argument("<id>")
    .action(async (id: string, _opts: unknown, cmd: Command) => {
      const name = normalizeBranchName(id);
      try {
        await withSession(cmd, async (session) => {
          await deleteBranch(session, name);
        });
      } catch (err) {
        if (err instanceof PlatformDownError) {
          progress(`DBLab host absent — nothing to delete for ${name}`);
          return;
        }
        throw err;
      }
    });
}
