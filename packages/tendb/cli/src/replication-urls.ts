import type { ApiSession } from "./context.js";
import { localizeUri } from "./commands/shared.js";

/**
 * Where the upstream replication pair lives, resolved once per session:
 * config/env first (hosted console, direct transport), then the SSM
 * parameters `<prefix>/replication/{publisher,subscriber}-url`. A subscriber
 * that runs ON the engine host is unreachable from a laptop, so over SSM its
 * port is forwarded like a clone's and `subscriber` rewritten to loopback;
 * `subscriberRemote` keeps the in-VPC form for display.
 */
export interface ReplicationUrls {
  publisher: string | null;
  /** Dial-ready form (tunnel-localized when needed). */
  subscriber: string | null;
  /** The as-published form, for display and Connect dialogs. */
  subscriberRemote: string | null;
}

export async function resolveReplicationUrls(
  session: ApiSession,
  opts: { onTunnelExit?: () => void } = {},
): Promise<ReplicationUrls> {
  const cfg = session.config;
  const fromParams = async (leaf: string) =>
    session.params
      ? await session.params.getParameter(`${cfg.ssmPrefix}/replication/${leaf}`, true).catch(() => null)
      : null;
  const publisher = cfg.replicationPublisherUrl ?? (await fromParams("publisher-url"));
  const subscriberRemote = cfg.replicationSubscriberUrl ?? (await fromParams("subscriber-url"));
  let subscriber = subscriberRemote;

  if (subscriber && session.canTunnel && session.params) {
    const engineHost = await session.params.getParameter(`${cfg.ssmPrefix}/host`).catch(() => null);
    try {
      const parsed = new URL(subscriber);
      if (engineHost && parsed.hostname === engineHost) {
        const tunnel = await session.openClonePort(Number(parsed.port || 5432));
        subscriber = localizeUri(subscriber, tunnel.localPort);
        if (opts.onTunnelExit) tunnel.onExit.then(opts.onTunnelExit);
      }
    } catch {
      // Unparseable URL — dial it verbatim and let the error surface.
    }
  }
  return { publisher, subscriber, subscriberRemote };
}
