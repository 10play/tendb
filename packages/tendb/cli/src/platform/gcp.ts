import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { MissingDependencyError, TenDBError } from "../errors.js";
import { spawnTunnelProcess } from "./spawn-tunnel.js";
import type { ParamStore, PlatformAdapter } from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * GCP: params in Secret Manager, tunnels through IAP TCP forwarding. Both go
 * through the gcloud CLI (no Google SDK dependency — mirrors how the AWS path
 * rides session-manager-plugin, and reuses the operator's existing auth).
 * The engine contract's `instance-id` value is the full instance path
 * `projects/<p>/zones/<z>/instances/<name>`.
 */

const GCLOUD_HINT =
  "install the Google Cloud CLI and authenticate:\n" +
  "  macOS:  brew install --cask google-cloud-sdk\n" +
  "  then:   gcloud auth login";

/** Secret Manager ids disallow "/": strip the leading one, map the rest to "_". */
export function gcpSecretName(paramName: string): string {
  return paramName.replace(/^\//, "").replaceAll("/", "_");
}

async function gcloud(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("gcloud", [...args, "--quiet"], {
      maxBuffer: 1024 * 1024,
    });
    return { ok: true, stdout, stderr };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    if (e.code === "ENOENT") {
      throw new MissingDependencyError("gcloud not found on PATH", GCLOUD_HINT);
    }
    return { ok: false, stdout: e.stdout ?? "", stderr: e.stderr ?? String(err) };
  }
}

class GcpParamStore implements ParamStore {
  constructor(private readonly project?: string) {}

  private projectArgs(): string[] {
    return this.project ? [`--project=${this.project}`] : [];
  }

  async getParameter(name: string): Promise<string | null> {
    const secret = gcpSecretName(name);
    const res = await gcloud([
      "secrets",
      "versions",
      "access",
      "latest",
      `--secret=${secret}`,
      ...this.projectArgs(),
    ]);
    if (res.ok) return res.stdout;
    if (/NOT_FOUND|not found|does not exist/i.test(res.stderr)) return null;
    throw new TenDBError(`gcloud secrets access failed for ${secret}`, 1, res.stderr.trim());
  }

  async putParameter(name: string, value: string): Promise<void> {
    const secret = gcpSecretName(name);
    // Value goes via stdin (--data-file=-) so it never appears in argv.
    const add = await this.withStdin(
      ["secrets", "versions", "add", secret, "--data-file=-", ...this.projectArgs()],
      value,
    );
    if (add.ok) return;
    if (!/NOT_FOUND|not found|does not exist/i.test(add.stderr)) {
      throw new TenDBError(`gcloud secrets add failed for ${secret}`, 1, add.stderr.trim());
    }
    const create = await this.withStdin(
      ["secrets", "create", secret, "--data-file=-", "--replication-policy=automatic", ...this.projectArgs()],
      value,
    );
    if (!create.ok) {
      throw new TenDBError(`gcloud secrets create failed for ${secret}`, 1, create.stderr.trim());
    }
  }

  private withStdin(args: string[], input: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        "gcloud",
        [...args, "--quiet"],
        { maxBuffer: 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
            reject(new MissingDependencyError("gcloud not found on PATH", GCLOUD_HINT));
            return;
          }
          resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr) });
        },
      );
      child.stdin?.end(input);
    });
  }
}

/** Parse the contract's instance path into tunnel arguments. */
export function parseGcpInstancePath(target: string): { project: string; zone: string; name: string } {
  const m = target.match(/^projects\/([^/]+)\/zones\/([^/]+)\/instances\/([^/]+)$/);
  if (!m) {
    throw new TenDBError(
      `unexpected GCP instance-id "${target}"`,
      1,
      "expected projects/<project>/zones/<zone>/instances/<name> (published by the gcp engine module)",
    );
  }
  return { project: m[1]!, zone: m[2]!, name: m[3]! };
}

export function createGcpAdapter(opts: { gcpProject?: string }): PlatformAdapter {
  return {
    platform: "gcp",
    transport: "iap",
    params: new GcpParamStore(opts.gcpProject),
    openTunnel: async (target, remotePort, localPort) => {
      const { project, zone, name } = parseGcpInstancePath(target);
      return spawnTunnelProcess({
        command: "gcloud",
        args: (port) => [
          "compute",
          "start-iap-tunnel",
          name,
          String(remotePort),
          `--local-host-port=localhost:${port}`,
          `--zone=${zone}`,
          `--project=${project}`,
          "--quiet",
        ],
        localPort,
        remotePort,
        missingHint: GCLOUD_HINT,
      });
    },
    close: async () => {},
  };
}
