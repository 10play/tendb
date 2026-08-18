import { spawn, type ChildProcess } from "node:child_process";
import { MissingDependencyError } from "../errors.js";
import { getFreePort, waitForTcp } from "../util/ports.js";
import type { SsmFacade } from "./params.js";
import type { Tunnel } from "../platform/types.js";

// Tunnel now lives in the platform layer; re-exported for back-compat.
export type { Tunnel } from "../platform/types.js";

const PLUGIN_HINT =
  "install the AWS Session Manager plugin:\n" +
  "  macOS:  brew install --cask session-manager-plugin\n" +
  "  Ubuntu: curl -fsSL https://s3.amazonaws.com/session-manager-downloads/plugin/latest/ubuntu_64bit/session-manager-plugin.deb -o /tmp/smp.deb && sudo dpkg -i /tmp/smp.deb";

/**
 * SSM port-forward without the aws CLI: call StartSession via the SDK, then
 * hand the {SessionId, TokenValue, StreamUrl} triple to session-manager-plugin
 * using the same six-argument invocation `aws ssm start-session` uses.
 */
export async function startPortForward(
  ssm: SsmFacade,
  opts: { instanceId: string; remotePort: number; localPort?: number; readyTimeoutMs?: number },
): Promise<Tunnel> {
  const localPort = opts.localPort ?? (await getFreePort());
  const region = await ssm.region();
  const sessionInput = {
    target: opts.instanceId,
    documentName: "AWS-StartPortForwardingSession",
    parameters: {
      portNumber: [String(opts.remotePort)],
      localPortNumber: [String(localPort)],
    },
  };
  const session = await ssm.startSession(sessionInput);

  const child = spawnPlugin(session, region, sessionInput, ssm.profile);

  let exited = false;
  const onExit = new Promise<void>((resolve) => {
    child.once("exit", () => {
      exited = true;
      resolve();
    });
  });

  const spawnError = new Promise<never>((_, reject) => {
    child.once("error", (err: NodeJS.ErrnoException) => {
      reject(
        err.code === "ENOENT"
          ? new MissingDependencyError("session-manager-plugin not found on PATH", PLUGIN_HINT)
          : err,
      );
    });
  });

  const close = async () => {
    if (!exited) {
      child.kill("SIGTERM");
      await onExit;
    }
    await ssm.terminateSession(session.sessionId).catch(() => {});
  };

  try {
    await Promise.race([waitForTcp(localPort, opts.readyTimeoutMs ?? 30_000), spawnError, deadPlugin(onExit)]);
  } catch (err) {
    await close();
    throw err;
  }

  return { localPort, remotePort: opts.remotePort, close, onExit };
}

async function deadPlugin(onExit: Promise<void>): Promise<never> {
  await onExit;
  throw new Error("session-manager-plugin exited before the tunnel became ready");
}

function spawnPlugin(
  session: { sessionId: string; tokenValue: string; streamUrl: string },
  region: string,
  sessionInput: { target: string; documentName: string; parameters: Record<string, string[]> },
  profile: string | undefined,
): ChildProcess {
  // The de-facto argv contract of the plugin (what the aws CLI passes):
  //   1: StartSession response JSON  2: region  3: "StartSession"
  //   4: profile name  5: request parameters JSON  6: ssm endpoint
  return spawn(
    "session-manager-plugin",
    [
      JSON.stringify({
        SessionId: session.sessionId,
        TokenValue: session.tokenValue,
        StreamUrl: session.streamUrl,
      }),
      region,
      "StartSession",
      profile ?? "",
      JSON.stringify({
        Target: sessionInput.target,
        DocumentName: sessionInput.documentName,
        Parameters: sessionInput.parameters,
      }),
      `https://ssm.${region}.amazonaws.com`,
    ],
    { stdio: ["ignore", "ignore", "ignore"] },
  );
}
