import { PlatformDownError } from "../errors.js";
import type { ResolvedConfig } from "../config.js";
import type { Discovered, ParamStore } from "./types.js";

/**
 * Discovery contract with the terraform modules: parameters under
 * `${ssmPrefix}/` (see terraform/docs/ENGINE-CONTRACT.md). A missing
 * instance-id parameter means the platform stack is down — the standard
 * "nothing exists" signal on every platform (absent SSM parameter, absent
 * secret, absent params.json entry).
 */
export async function discover(params: ParamStore, cfg: ResolvedConfig): Promise<Discovered> {
  const p = (leaf: string) => `${cfg.ssmPrefix}/${leaf}`;

  const instanceId = cfg.instanceId ?? (await params.getParameter(p("instance-id")));
  if (!instanceId) {
    throw new PlatformDownError(
      `DBLab host not found (${p("instance-id")} missing — platform down?)`,
      "bring the platform up first (e.g. `make up` or `terraform apply`)",
    );
  }
  const token = cfg.token ?? (await params.getParameter(p("verification-token"), true));
  if (!token) {
    throw new PlatformDownError(`verification token not found at ${p("verification-token")}`);
  }
  const database = cfg.database ?? (await params.getParameter(p("dbname"))) ?? undefined;
  const host = (await params.getParameter(p("host"))) ?? undefined;
  return { instanceId, token, database, host };
}
