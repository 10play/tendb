import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

interface MockClone {
  id: string;
  branch: string;
  db: { host: string; port: number; username: string };
  /** Status codes returned by successive GETs; the last one sticks. */
  statusQueue: string[];
}

/**
 * In-process fixture implementing the eight DBLab endpoints the CLI uses.
 * State is plain fields — tests mutate it directly to script scenarios.
 */
export class MockDblab {
  token = "testtoken123";
  snapshots: Array<Record<string, unknown>> = [
    { id: "snap-1", createdAt: "2026-08-16T02:00:00Z", dataStateAt: "2026-08-16T02:00:00Z", logicalSize: 123456789 },
  ];
  branches: Array<Record<string, unknown>> = [{ name: "main", dataStateAt: "2026-08-16T02:00:00Z" }];
  clones = new Map<string, MockClone>();
  /** When set, POST /clone fails once with this response, then clears. */
  failNextCloneCreate: { status: number; message: string } | undefined;
  /** Status codes new clones step through on successive GETs (default: OK). */
  newCloneStatusQueue: string[] = ["OK"];
  requests: Array<{ method: string; path: string }> = [];

  private server: Server | undefined;
  private nextPort = 6000;

  async listen(): Promise<string> {
    this.server = createServer((req, res) => {
      const send = (status: number, body?: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(body === undefined ? "" : JSON.stringify(body));
      };
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const path = url.pathname;
        const method = req.method ?? "GET";
        this.requests.push({ method, path });
        if (path !== "/healthz" && req.headers["verification-token"] !== this.token) {
          return send(401, { message: "invalid token" });
        }
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
        this.handle(method, path, body, send);
      });
    });
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", r));
    const { port } = this.server!.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async close(): Promise<void> {
    await new Promise<void>((r) => this.server?.close(() => r()));
  }

  private cloneJson(c: MockClone): Record<string, unknown> {
    const code = c.statusQueue.length > 1 ? c.statusQueue.shift()! : c.statusQueue[0]!;
    return {
      id: c.id,
      branch: c.branch,
      status: { code, message: code === "FATAL" ? "mock failure" : "" },
      db: { ...c.db },
      createdAt: "2026-08-16T10:00:00Z",
    };
  }

  private handle(
    method: string,
    path: string,
    body: Record<string, unknown> | undefined,
    send: (status: number, body?: unknown) => void,
  ): void {
    if (method === "GET" && path === "/healthz") return send(200, { version: "4.1.3-mock" });
    if (method === "GET" && path === "/snapshots") return send(200, this.snapshots);
    if (method === "GET" && path === "/branches") return send(200, this.branches);
    if (method === "GET" && path === "/status") {
      return send(200, {
        engine: { version: "4.1.3-mock" },
        cloning: { clones: [...this.clones.values()].map((c) => this.cloneJson(c)) },
        retrieving: { mode: "logical", status: "finished", lastRefresh: "2026-08-16T02:00:00Z" },
        pools: [{ name: "dblab_pool", dataStateAt: "2026-08-16T02:00:00Z", fileSystem: { size: 21474836480, free: 10737418240, used: 10737418240 } }],
      });
    }
    if (method === "POST" && path === "/branch") {
      this.branches.push({ name: body?.branchName });
      return send(200, {});
    }
    if (method === "DELETE" && path.startsWith("/branch/")) {
      const name = path.slice("/branch/".length);
      const before = this.branches.length;
      this.branches = this.branches.filter((b) => b.name !== name);
      // Faithful to DLE 4.1.3's absent-branch response (400, odd grammar).
      return this.branches.length < before
        ? send(200, {})
        : send(400, { message: `failed to found dataset of the branch: ${name}` });
    }
    if (method === "GET" && path.startsWith("/clone/")) {
      const clone = this.clones.get(path.slice("/clone/".length));
      return clone ? send(200, this.cloneJson(clone)) : send(404, { message: "clone not found" });
    }
    if (method === "POST" && path === "/clone") {
      if (this.failNextCloneCreate) {
        const fail = this.failNextCloneCreate;
        this.failNextCloneCreate = undefined;
        return send(fail.status, { message: fail.message });
      }
      const id = String(body?.id);
      const db = body?.db as { username: string };
      this.clones.set(id, {
        id,
        branch: String(body?.branch),
        db: { host: "10.40.1.99", port: this.nextPort++, username: db.username },
        statusQueue: [...this.newCloneStatusQueue],
      });
      return send(201, {});
    }
    if (method === "DELETE" && path.startsWith("/clone/")) {
      const id = path.slice("/clone/".length);
      // Faithful to DLE 4.1.3: deleting an absent clone is a 500, not a 404.
      return this.clones.delete(id) ? send(200, {}) : send(500, { message: "clone not found" });
    }
    if (method === "POST" && path === "/full-refresh") return send(404, { message: "not found" });
    send(404, { message: `unhandled ${method} ${path}` });
  }
}
