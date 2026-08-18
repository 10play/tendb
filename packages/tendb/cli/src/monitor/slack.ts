import type { Finding, FindingCode } from "./checkup.js";

/**
 * Slack incoming-webhook payloads for alert transitions, rendered with Block
 * Kit inside a color-barred attachment (the bar is only available on
 * attachments). The top-level `text` is the notification fallback.
 */

export interface AlertEvent {
  at: string;
  type: "alert" | "recover";
  code: FindingCode;
  finding?: Finding;
}

interface SlackBlock {
  type: "section" | "context";
  text?: { type: "mrkdwn"; text: string };
  fields?: { type: "mrkdwn"; text: string }[];
  elements?: { type: "mrkdwn"; text: string }[];
}

export interface SlackPayload {
  text: string;
  attachments: { color: string; blocks: SlackBlock[] }[];
}

const COLORS = {
  critical: "#E01E5A",
  warning: "#ECB22E",
  recover: "#2EB67D",
} as const;

/** `<!date^…>` renders in each reader's own timezone; ISO is the fallback. */
function timestamp(at: string): string {
  const epoch = Math.floor(new Date(at).getTime() / 1000);
  if (!Number.isFinite(epoch)) return at;
  return `<!date^${epoch}^{date_short_pretty} at {time}|${at}>`;
}

function contextLine(event: AlertEvent, source: string, consoleUrl?: string): SlackBlock {
  const parts = [source, timestamp(event.at)];
  if (consoleUrl) parts.push(`<${consoleUrl.replace(/\/$/, "")}/#/alerts|Open console>`);
  return { type: "context", elements: [{ type: "mrkdwn", text: parts.join("  ·  ") }] };
}

export function slackPayload(
  event: AlertEvent,
  opts: { source?: string; consoleUrl?: string } = {},
): SlackPayload {
  const source = opts.source ?? "tendb";

  if (event.type === "recover") {
    return {
      text: `${source} — recovered: ${event.code}`,
      attachments: [
        {
          color: COLORS.recover,
          blocks: [
            {
              type: "section",
              text: { type: "mrkdwn", text: `:white_check_mark: *Recovered · \`${event.code}\`*` },
            },
            contextLine(event, source, opts.consoleUrl),
          ],
        },
      ],
    };
  }

  const severity = event.finding?.severity ?? "warning";
  const critical = severity === "critical";
  const blocks: SlackBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${critical ? ":rotating_light:" : ":warning:"} *${critical ? "Critical" : "Warning"} · \`${event.code}\`*`,
      },
    },
  ];
  if (event.finding?.message) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: event.finding.message } });
  }
  const fields: { type: "mrkdwn"; text: string }[] = [];
  if (event.finding?.value !== undefined) {
    fields.push({ type: "mrkdwn", text: `*Observed*\n${event.finding.value}` });
  }
  if (event.finding?.threshold !== undefined) {
    fields.push({ type: "mrkdwn", text: `*Threshold*\n${event.finding.threshold}` });
  }
  if (fields.length > 0) blocks.push({ type: "section", fields });
  blocks.push(contextLine(event, source, opts.consoleUrl));

  return {
    text: `${source} — ${severity}: ${event.code}${event.finding?.message ? ` — ${event.finding.message}` : ""}`,
    attachments: [{ color: critical ? COLORS.critical : COLORS.warning, blocks }],
  };
}

export async function postToSlack(
  webhookUrl: string,
  event: AlertEvent,
  fetchImpl: typeof fetch = fetch,
  opts: { source?: string; consoleUrl?: string } = {},
): Promise<boolean> {
  try {
    const res = await fetchImpl(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(slackPayload(event, opts)),
    });
    return res.ok;
  } catch {
    return false;
  }
}
