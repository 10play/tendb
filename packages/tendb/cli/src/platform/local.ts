import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ParamStore, PlatformAdapter, Tunnel } from "./types.js";

/**
 * Local (Docker) platform: the engine container publishes its ports on
 * 127.0.0.1, so a "tunnel" is the identity mapping, and the contract params
 * live in a params.json written by the terraform local module (and updated by
 * the local snapshotd container). Default state dir: ~/.tendb/local.
 */

export const DEFAULT_LOCAL_STATE_DIR = join(homedir(), ".tendb", "local");

type ParamsFile = Record<string, { value: string; secure?: boolean }>;

/**
 * File-backed ParamStore over `<stateDir>/params.json`. Reads are fresh on
 * every call (snapshotd writes the same file); writes are atomic
 * (tmp + rename) and keep the file at mode 0600 — it holds the token.
 */
export class FileParamStore implements ParamStore {
  constructor(private readonly path: string) {}

  private read(): ParamsFile {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw err;
    }
    try {
      return JSON.parse(raw) as ParamsFile;
    } catch {
      return {};
    }
  }

  async getParameter(name: string): Promise<string | null> {
    return this.read()[name]?.value ?? null;
  }

  async putParameter(name: string, value: string, secure = false): Promise<void> {
    const all = this.read();
    all[name] = secure ? { value, secure: true } : { value };
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.path);
    chmodSync(this.path, 0o600);
  }
}

export function localParamsPath(stateDir?: string): string {
  return join(stateDir ?? DEFAULT_LOCAL_STATE_DIR, "params.json");
}

/**
 * Ports are already on loopback — the tunnel is an identity mapping. When the
 * caller asks for a *different* local port (`tendb tunnel -p`), a small TCP
 * relay bridges it so the command keeps its contract.
 */
export async function identityTunnel(remotePort: number, localPort?: number): Promise<Tunnel> {
  if (localPort === undefined || localPort === remotePort) {
    return {
      localPort: remotePort,
      remotePort,
      close: async () => {},
      onExit: new Promise<void>(() => {}),
    };
  }
  const server = createServer((client) => {
    const upstream = connect(remotePort, "127.0.0.1");
    client.pipe(upstream).pipe(client);
    const drop = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", drop);
    upstream.on("error", drop);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(localPort, "127.0.0.1", resolve);
  });
  return {
    localPort,
    remotePort,
    close: () => new Promise((resolve) => server.close(() => resolve())),
    onExit: new Promise<void>(() => {}),
  };
}

export function createLocalAdapter(opts: { stateDir?: string }): PlatformAdapter {
  return {
    platform: "local",
    transport: "local",
    params: new FileParamStore(localParamsPath(opts.stateDir)),
    openTunnel: (_target, remotePort, localPort) => identityTunnel(remotePort, localPort),
    close: async () => {},
  };
}
