import { describe, expect, it } from "vitest";
import { slackPayload } from "../src/monitor/slack.js";

const finding = {
  code: "replication-errors" as const,
  severity: "warning" as const,
  message: "subscription tendb_stream reported 255 apply / 0 sync errors",
  value: 255,
  threshold: 0,
};

describe("slackPayload", () => {
  it("renders alerts as a color-barred Block Kit attachment", () => {
    const payload = slackPayload({
      at: "2026-08-17T18:00:00.000Z",
      type: "alert",
      code: "replication-errors",
      finding,
    });

    expect(payload.text).toContain("warning: replication-errors");
    const attachment = payload.attachments[0]!;
    expect(attachment.color).toBe("#ECB22E");
    const [title, message, fields, context] = attachment.blocks as [
      (typeof attachment.blocks)[number],
      (typeof attachment.blocks)[number],
      (typeof attachment.blocks)[number],
      (typeof attachment.blocks)[number],
    ];
    expect(title.text?.text).toContain("`replication-errors`");
    expect(message.text?.text).toBe(finding.message);
    expect(fields.fields?.map((f) => f.text)).toEqual(["*Observed*\n255", "*Threshold*\n0"]);
    // <!date^…> renders in the reader's timezone with the ISO fallback.
    expect(context.elements?.[0]?.text).toContain("<!date^1786989600^");
  });

  it("uses the critical color and skips absent fields", () => {
    const payload = slackPayload({
      at: "2026-08-17T18:00:00.000Z",
      type: "alert",
      code: "engine-unreachable",
      finding: { code: "engine-unreachable", severity: "critical", message: "engine down" },
    });

    const attachment = payload.attachments[0]!;
    expect(attachment.color).toBe("#E01E5A");
    expect(attachment.blocks.some((b) => b.fields)).toBe(false);
    expect(attachment.blocks[0]!.text?.text).toContain("Critical");
  });

  it("renders recoveries green with a console link when configured", () => {
    const payload = slackPayload(
      { at: "2026-08-17T18:00:00.000Z", type: "recover", code: "schema-drift" },
      { consoleUrl: "https://console.example.com/" },
    );

    expect(payload.text).toBe("tendb — recovered: schema-drift");
    const attachment = payload.attachments[0]!;
    expect(attachment.color).toBe("#2EB67D");
    expect(attachment.blocks[0]!.text?.text).toContain("Recovered");
    expect(attachment.blocks.at(-1)?.elements?.[0]?.text).toContain(
      "<https://console.example.com/#/alerts|Open console>",
    );
  });
});
