import { createSsmFacade, type SsmFacade } from "../aws/params.js";
import { startPortForward } from "../aws/session.js";
import type { PlatformAdapter } from "./types.js";
import type { ResolvedConfig } from "../config.js";

/**
 * AWS: params in SSM Parameter Store, tunnels through SSM Session Manager
 * (session-manager-plugin). Wraps the pre-existing facade untouched so the
 * live deployment's behavior — including the plugin's six-argv contract —
 * stays byte-identical. Reports transport "ssm" for status back-compat.
 */
export interface AwsAdapter extends PlatformAdapter {
  /** The underlying facade, kept for SDK back-compat (`session.ssm`). */
  ssm: SsmFacade;
}

export function createAwsAdapter(cfg: Pick<ResolvedConfig, "region" | "profile">): AwsAdapter {
  const ssm = createSsmFacade(cfg);
  return {
    platform: "aws",
    transport: "ssm",
    params: ssm,
    ssm,
    openTunnel: (target, remotePort, localPort) =>
      startPortForward(ssm, { instanceId: target, remotePort, localPort }),
    close: async () => {},
  };
}
