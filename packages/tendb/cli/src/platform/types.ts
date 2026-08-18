import type { ResolvedConfig } from "../config.js";

/**
 * The platform seam. Every deployment target (AWS, GCP, Azure, local Docker)
 * provides two capabilities behind one adapter:
 *   - a ParamStore holding the engine contract namespace (discovery values,
 *     snapshot/schema control, alert settings) — SSM Parameter Store on AWS,
 *     Secret Manager on GCP, Key Vault on Azure, a params.json file locally;
 *   - a tunnel opener that forwards a host port to 127.0.0.1 — SSM Session
 *     Manager, IAP TCP forwarding, Bastion native-client tunnel, or (locally)
 *     an identity mapping because the ports are already published on loopback.
 * See terraform/docs/ENGINE-CONTRACT.md for the full contract.
 */

/** Key-value access to the engine contract namespace (`<prefix>/...`). */
export interface ParamStore {
  getParameter(name: string, decrypt?: boolean): Promise<string | null>;
  putParameter(name: string, value: string, secure?: boolean): Promise<void>;
}

export interface Tunnel {
  localPort: number;
  remotePort: number;
  close(): Promise<void>;
  /** Resolves if the tunnel dies on its own (process exit) — for respawn logic. */
  onExit: Promise<void>;
}

export type PlatformName = "aws" | "gcp" | "azure" | "local";

/** AWS keeps reporting "ssm" so status JSON stays byte-compatible. */
export type TransportName = "ssm" | "iap" | "bastion" | "local" | "direct";

export interface PlatformAdapter {
  readonly platform: PlatformName;
  readonly transport: Exclude<TransportName, "direct">;
  readonly params: ParamStore;
  /**
   * Forward `remotePort` on the engine host to a local port. `target` is the
   * discovered `instance-id` contract value — opaque and platform-shaped
   * (EC2 instance id, GCP instance path, Azure VM resource id, container name).
   */
  openTunnel(target: string, remotePort: number, localPort?: number): Promise<Tunnel>;
  close(): Promise<void>;
}

export interface Discovered {
  instanceId: string;
  token: string;
  database?: string;
  host?: string;
}

export type PlatformConfig = Pick<
  ResolvedConfig,
  | "platform"
  | "ssmPrefix"
  | "region"
  | "profile"
  | "instanceId"
  | "gcpProject"
  | "azureVault"
  | "stateDir"
  | "token"
  | "database"
>;
