import { UsageError } from "../errors.js";
import type { ResolvedConfig } from "../config.js";
import type { SsmFacade } from "../aws/params.js";
import { createSsmFacade } from "../aws/params.js";
import { createAwsAdapter } from "./aws.js";
import { createGcpAdapter, gcpSecretName } from "./gcp.js";
import { createAzureAdapter, azureSecretName } from "./azure.js";
import { createLocalAdapter, FileParamStore, localParamsPath } from "./local.js";
import type { ParamStore, PlatformAdapter, PlatformName } from "./types.js";

/**
 * Adapter selection. `platform` defaults to "aws" (back-compat); `apiUrl`
 * still short-circuits to direct mode before any adapter is created — see
 * openSession in context.ts.
 */
export function createAdapter(cfg: ResolvedConfig): PlatformAdapter & { ssm?: SsmFacade } {
  switch (cfg.platform) {
    case "aws":
      return createAwsAdapter(cfg);
    case "gcp":
      return createGcpAdapter(cfg);
    case "azure":
      return createAzureAdapter(cfg);
    case "local":
      return createLocalAdapter(cfg);
  }
}

/**
 * A standalone ParamStore for control-plane access (snapshot/schema config,
 * alert settings) when there is no platform session — the hosted console runs
 * on direct transport and reaches the store this way. Throws a UsageError
 * with a platform-specific hint when the config can't reach one.
 */
export function createParamStore(cfg: ResolvedConfig): ParamStore {
  switch (cfg.platform) {
    case "aws":
      if (!cfg.region) {
        throw new UsageError(
          "snapshot control needs AWS access",
          "set region (TENDB_REGION or tendb.json) so the SSM parameters are reachable",
        );
      }
      return createSsmFacade(cfg);
    case "gcp":
      return createGcpAdapter(cfg).params;
    case "azure":
      return createAzureAdapter(cfg).params;
    case "local":
      return new FileParamStore(localParamsPath(cfg.stateDir));
  }
}

/**
 * How a contract param name maps onto each platform's store, per
 * terraform/docs/ENGINE-CONTRACT.md. AWS and local use names verbatim.
 */
export function mapParamName(platform: PlatformName, name: string): string {
  switch (platform) {
    case "aws":
    case "local":
      return name;
    case "gcp":
      return gcpSecretName(name);
    case "azure":
      return azureSecretName(name);
  }
}
