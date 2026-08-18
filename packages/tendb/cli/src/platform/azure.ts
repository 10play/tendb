import { execFile } from "node:child_process";
import { MissingDependencyError, TenDBError, UsageError } from "../errors.js";
import { spawnTunnelProcess } from "./spawn-tunnel.js";
import type { ParamStore, PlatformAdapter } from "./types.js";

/**
 * Azure: params in Key Vault, tunnels through the Bastion native-client
 * tunnel (`az network bastion tunnel`; needs a Standard-SKU Bastion with
 * tunneling enabled — the azure engine module provisions it and publishes its
 * resource id as the `bastion-id` contract param). Everything rides the az
 * CLI — no Azure SDK dependency, and the operator's existing `az login` auth
 * is reused.
 */

const AZ_HINT =
  "install the Azure CLI and authenticate:\n" +
  "  macOS:  brew install azure-cli\n" +
  "  then:   az login";

/** Key Vault secret names allow only [0-9a-zA-Z-]: strip the leading "/", map the rest to "-". */
export function azureSecretName(paramName: string): string {
  return paramName.replace(/^\//, "").replaceAll("/", "-");
}

function az(args: string[], input?: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile("az", args, { maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new MissingDependencyError("az not found on PATH", AZ_HINT));
        return;
      }
      resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr) });
    });
    if (input !== undefined) child.stdin?.end(input);
    else child.stdin?.end();
  });
}

class AzureParamStore implements ParamStore {
  constructor(private readonly vault: string) {}

  async getParameter(name: string): Promise<string | null> {
    const secret = azureSecretName(name);
    const res = await az([
      "keyvault",
      "secret",
      "show",
      "--vault-name",
      this.vault,
      "--name",
      secret,
      "--query",
      "value",
      "--output",
      "tsv",
    ]);
    if (res.ok) return res.stdout.replace(/\r?\n$/, "");
    if (/SecretNotFound|was not found|NotFound/i.test(res.stderr)) return null;
    throw new TenDBError(`az keyvault secret show failed for ${secret}`, 1, res.stderr.trim());
  }

  async putParameter(name: string, value: string): Promise<void> {
    const secret = azureSecretName(name);
    // Value goes via stdin (--file /dev/stdin) so it never appears in argv.
    const res = await az(
      ["keyvault", "secret", "set", "--vault-name", this.vault, "--name", secret, "--file", "/dev/stdin"],
      value,
    );
    if (!res.ok) {
      throw new TenDBError(`az keyvault secret set failed for ${secret}`, 1, res.stderr.trim());
    }
  }
}

/** Parse a Bastion host ARM resource id into tunnel arguments. */
export function parseBastionId(id: string): { resourceGroup: string; name: string } {
  const m = id.match(/\/resourceGroups\/([^/]+)\/providers\/Microsoft\.Network\/bastionHosts\/([^/]+)$/i);
  if (!m) {
    throw new TenDBError(
      `unexpected bastion-id "${id}"`,
      1,
      "expected a Bastion host resource id (published by the azure engine module)",
    );
  }
  return { resourceGroup: m[1]!, name: m[2]! };
}

export function createAzureAdapter(opts: { azureVault?: string; ssmPrefix: string }): PlatformAdapter {
  if (!opts.azureVault) {
    throw new UsageError(
      "the azure platform needs a Key Vault name",
      "set `azureVault` in tendb.json or TENDB_AZURE_VAULT (the vault the azure engine module created)",
    );
  }
  const params = new AzureParamStore(opts.azureVault);
  return {
    platform: "azure",
    transport: "bastion",
    params,
    openTunnel: async (target, remotePort, localPort) => {
      const bastionId = await params.getParameter(`${opts.ssmPrefix}/bastion-id`);
      if (!bastionId) {
        throw new TenDBError(
          "bastion-id parameter not found",
          1,
          `the azure engine module publishes ${opts.ssmPrefix}/bastion-id — is the platform up?`,
        );
      }
      const { resourceGroup, name } = parseBastionId(bastionId);
      return spawnTunnelProcess({
        command: "az",
        args: (port) => [
          "network",
          "bastion",
          "tunnel",
          "--name",
          name,
          "--resource-group",
          resourceGroup,
          "--target-resource-id",
          target,
          "--resource-port",
          String(remotePort),
          "--port",
          String(port),
        ],
        localPort,
        remotePort,
        missingHint: AZ_HINT,
      });
    },
    close: async () => {},
  };
}
