import { spawn } from "node:child_process";
import type { Command } from "commander";
import { API_PORT, UI_PORT } from "../context.js";
import { UsageError } from "../errors.js";
import { progress, warn } from "../output.js";
import { withSession } from "./shared.js";

export function openBrowser(url: string): void {
  const bin = process.platform === "darwin" ? "open" : "xdg-open";
  const child = spawn(bin, [url], { stdio: "ignore", detached: true });
  child.once("error", () => warn(`could not open a browser — visit ${url}`));
  child.unref();
}

export function registerUi(program: Command): void {
  program
    .command("ui")
    .description("open DBLab's embedded web UI (the low-level engine console)")
    .option("--no-open", "do not open a browser")
    .action(async (opts: { open: boolean }, cmd: Command) => {
      await withSession(cmd, async (session) => {
        if (!session.canTunnel) {
          throw new UsageError("`ui` needs a platform session (the embedded UI is bound to the host's loopback)");
        }
        // The embedded UI calls localhost:2345 from the browser, so both local
        // ports must match the remote ones exactly.
        await session.openClonePort(UI_PORT, UI_PORT);
        // API is already tunnelled on a random port; add a fixed 2345 mapping.
        await session.openClonePort(API_PORT, API_PORT);
        const url = `http://localhost:${UI_PORT}`;
        progress(`DBLab UI: ${url}`);
        process.stdout.write(`verification token (paste into the UI auth field): ${session.token}\n`);
        if (opts.open) openBrowser(url);
        progress("ctrl-c to stop");
        await new Promise<void>((r) => {
          process.once("SIGINT", () => r());
          process.once("SIGTERM", () => r());
        });
      });
    });
}
