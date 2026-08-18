import type { Command } from "commander";
import { ConsoleServer } from "../console/server.js";
import { progress } from "../output.js";
import { openBrowser } from "./ui.js";
import { withSession } from "./shared.js";

export function registerConsole(program: Command): void {
  program
    .command("console")
    .description("open the tendb console (Neon-style dashboard served locally)")
    .option("--port <port>", "local port", "4400")
    .option("--no-open", "do not open a browser")
    .action(async (opts: { port: string; open: boolean }, cmd: Command) => {
      await withSession(cmd, async (session) => {
        // TENDB_STATE_DIR (set by the hosted service) persists the alert
        // feed and seen-findings map across restarts and releases.
        const server = new ConsoleServer(session, { stateDir: process.env.TENDB_STATE_DIR });
        const port = await server.listen(Number(opts.port));
        const url = `http://localhost:${port}`;
        progress(`tendb console: ${url}`);
        if (opts.open) openBrowser(url);
        progress("ctrl-c to stop");
        try {
          await new Promise<void>((r) => {
            process.once("SIGINT", () => r());
            process.once("SIGTERM", () => r());
          });
        } finally {
          await server.close();
        }
      });
    });
}
