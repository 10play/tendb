import {
  GetParameterCommand,
  ParameterNotFound,
  PutParameterCommand,
  SSMClient,
  StartSessionCommand,
  TerminateSessionCommand,
} from "@aws-sdk/client-ssm";
import { fromIni } from "@aws-sdk/credential-providers";
import { PlatformDownError } from "../errors.js";
import type { ResolvedConfig } from "../config.js";

export interface StartedSession {
  sessionId: string;
  tokenValue: string;
  streamUrl: string;
}

/**
 * Thin facade over the SSM API — the only AWS surface the CLI touches.
 * Injected into transport code so tests can fake it.
 */
export interface SsmFacade {
  region(): Promise<string>;
  profile?: string;
  getParameter(name: string, decrypt?: boolean): Promise<string | null>;
  putParameter(name: string, value: string, secure?: boolean): Promise<void>;
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

export interface Discovered {
  instanceId: string;
  token: string;
  database?: string;
  host?: string;
}

/**
 * Discovery contract with the terraform module: parameters under
 * `${ssmPrefix}/`. A missing instance-id parameter means the platform stack is
 * down — the standard "nothing exists" signal.
 */
export async function discover(ssm: SsmFacade, cfg: ResolvedConfig): Promise<Discovered> {
  const p = (leaf: string) => `${cfg.ssmPrefix}/${leaf}`;

  const instanceId = cfg.instanceId ?? (await ssm.getParameter(p("instance-id")));
  if (!instanceId) {
    throw new PlatformDownError(
      `DBLab host not found (${p("instance-id")} missing — platform down?)`,
      "bring the platform up first (e.g. `make up` or `terraform apply`)",
    );
  }
  const token = cfg.token ?? (await ssm.getParameter(p("verification-token"), true));
  if (!token) {
    throw new PlatformDownError(`verification token not found at ${p("verification-token")}`);
  }
  const database = cfg.database ?? (await ssm.getParameter(p("dbname"))) ?? undefined;
  const host = (await ssm.getParameter(p("host"))) ?? undefined;
  return { instanceId, token, database, host };
}
