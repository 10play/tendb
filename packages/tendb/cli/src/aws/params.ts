import {
  GetParameterCommand,
  ParameterNotFound,
  PutParameterCommand,
  SSMClient,
  StartSessionCommand,
  TerminateSessionCommand,
} from "@aws-sdk/client-ssm";
import { fromIni } from "@aws-sdk/credential-providers";
import type { ResolvedConfig } from "../config.js";
import type { ParamStore } from "../platform/types.js";

export interface StartedSession {
  sessionId: string;
  tokenValue: string;
  streamUrl: string;
}

/**
 * Thin facade over the SSM API — the only AWS surface the CLI touches.
 * Injected into transport code so tests can fake it. Its param half doubles
 * as the AWS ParamStore for the platform layer.
 */
export interface SsmFacade extends ParamStore {
  region(): Promise<string>;
  profile?: string;
  startSession(input: {
    target: string;
    documentName: string;
    parameters: Record<string, string[]>;
  }): Promise<StartedSession>;
  terminateSession(sessionId: string): Promise<void>;
}

export function createSsmFacade(cfg: Pick<ResolvedConfig, "region" | "profile">): SsmFacade {
  const client = new SSMClient({
    ...(cfg.region ? { region: cfg.region } : {}),
    ...(cfg.profile ? { credentials: fromIni({ profile: cfg.profile }) } : {}),
  });
  return {
    profile: cfg.profile,
    region: async () => {
      const r = client.config.region;
      return typeof r === "function" ? r() : r;
    },
    getParameter: async (name, decrypt = false) => {
      try {
        const res = await client.send(new GetParameterCommand({ Name: name, WithDecryption: decrypt }));
        return res.Parameter?.Value ?? null;
      } catch (err) {
        if (err instanceof ParameterNotFound) return null;
        throw err;
      }
    },
    putParameter: async (name, value, secure = false) => {
      await client.send(
        new PutParameterCommand({
          Name: name,
          Value: value,
          Type: secure ? "SecureString" : "String",
          Overwrite: true,
        }),
      );
    },
    startSession: async ({ target, documentName, parameters }) => {
      const res = await client.send(
        new StartSessionCommand({ Target: target, DocumentName: documentName, Parameters: parameters }),
      );
      if (!res.SessionId || !res.TokenValue || !res.StreamUrl) {
        throw new Error("StartSession returned an incomplete response");
      }
      return { sessionId: res.SessionId, tokenValue: res.TokenValue, streamUrl: res.StreamUrl };
    },
    terminateSession: async (sessionId) => {
      await client.send(new TerminateSessionCommand({ SessionId: sessionId }));
    },
  };
}

// Discovery moved to the platform layer (it only needs a ParamStore);
// re-exported here for back-compat with existing imports.
export { discover } from "../platform/discover.js";
export type { Discovered } from "../platform/types.js";
