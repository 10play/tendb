import { createServer, connect } from "node:net";
import { TimeoutError } from "../errors.js";

/** Bind to port 0, read the assigned port, release it. */
export function getFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      if (address === null || typeof address === "string") {
        srv.close();
        reject(new Error("could not determine free port"));
        return;
      }
      srv.close(() => resolvePort(address.port));
    });
  });
}

/** Poll until a TCP connect to 127.0.0.1:port succeeds. */
export async function waitForTcp(port: number, timeoutMs: number, intervalMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ok = await new Promise<boolean>((resolveProbe) => {
      const sock = connect({ port, host: "127.0.0.1" });
      sock.once("connect", () => {
        sock.destroy();
        resolveProbe(true);
      });
      sock.once("error", () => resolveProbe(false));
      sock.setTimeout(1000, () => {
        sock.destroy();
        resolveProbe(false);
      });
    });
    if (ok) return;
    if (Date.now() > deadline) {
      throw new TimeoutError(`port ${port} never became reachable (waited ${timeoutMs}ms)`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
