import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { ScreenHeader } from "../components/AppShell";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { ConfirmDialog } from "../components/Dialog";
import { Spinner } from "../components/Spinner";
import { useToast } from "../components/Toast";
import { AlertIcon, CheckIcon } from "../components/Icons";
import type { AlertEvent, CheckupFinding } from "../lib/api";
import { api } from "../lib/api";
import { formatAgeAgo, formatTimestamp } from "../lib/format";
import { useAlerts } from "../lib/queries";
import { useTicker } from "../lib/hooks";

export function AlertsScreen() {
  const alerts = useAlerts();
  const now = useTicker(10_000);

  const current = alerts.data?.current;
  const history = alerts.data?.history ?? [];

  return (
    <div className="mx-auto max-w-[1000px] px-5 py-7 md:px-8">
      <ScreenHeader
        title="Alerts"
        blurb="Findings from the checkup rules, evaluated every minute. Transitions land in the feed and, when configured, in Slack."
      />

      <Card label="current findings" className="mb-6">
        {alerts.isLoading ? (
          <p className="flex items-center gap-2 py-2 text-[13px] text-dim">
            <Spinner className="size-4 text-accent-ink" />
            Running checkup…
          </p>
        ) : current && current.findings.length > 0 ? (
          <ul className="flex flex-col gap-2.5">
            {current.findings.map((finding) => (
              <FindingRow key={finding.code} finding={finding} />
            ))}
          </ul>
        ) : (
          <p className="flex items-center gap-2 py-1 text-[13px] text-dim">
            <span className="size-1.5 rounded-full bg-accent" />
            All clear — no findings.
            {current ? (
              <span className="text-faint">checked {formatAgeAgo(current.measuredAt, now)}</span>
            ) : null}
          </p>
        )}
      </Card>

      <SchemaCard
        drifted={Boolean(current?.findings.some((f) => f.code === "schema-drift"))}
        onChanged={() => void alerts.refetch()}
      />

      <SlackCard configured={alerts.data?.slack.configured ?? false} onSaved={() => void alerts.refetch()} />

      <Card
        label="event feed"
        action={<span className="font-mono text-[11px] text-faint">recent events · {history.length}</span>}
      >
        {history.length === 0 ? (
          <p className="py-1 text-[13px] text-faint">
            No transitions yet. New findings and recoveries appear here as they happen.
          </p>
        ) : (
          <ul className="flex flex-col">
            {history.map((event, index) => (
              <EventRow key={`${event.at}-${event.code}-${index}`} event={event} now={now} />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function FindingRow({ finding }: { finding: CheckupFinding }) {
  const critical = finding.severity === "critical";
  return (
    <li className="flex items-start gap-2.5">
      <span
        className={`mt-0.5 inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[10.5px] font-medium ${
          critical ? "bg-danger/15 text-danger" : "bg-warn/15 text-warn"
        }`}
      >
        <span className={`size-1.5 rounded-full ${critical ? "bg-danger" : "bg-warn"}`} />
        {finding.severity}
      </span>
      <div className="min-w-0">
        <span className="font-mono text-[12px] text-ink">{finding.code}</span>
        <p className="text-[12.5px] leading-snug text-dim">{finding.message}</p>
      </div>
    </li>
  );
}

function EventRow({ event, now }: { event: AlertEvent; now: number }) {
  const recover = event.type === "recover";
  return (
    <li className="flex items-start gap-2.5 border-b border-line/60 py-2.5 last:border-b-0">
      {recover ? (
        <CheckIcon className="mt-0.5 size-4 shrink-0 text-accent-ink" />
      ) : (
        <AlertIcon
          className={`mt-0.5 size-4 shrink-0 ${event.finding?.severity === "critical" ? "text-danger" : "text-warn"}`}
        />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-[12px] text-ink">{event.code}</span>
          <span className="text-[11px] text-faint" title={formatTimestamp(event.at)}>
            {formatAgeAgo(event.at, now)}
          </span>
        </div>
        <p className="text-[12.5px] leading-snug text-dim">
          {recover ? "recovered" : (event.finding?.message ?? "alert")}
        </p>
      </div>
    </li>
  );
}

/**
 * DDL never replicates: schema drift is silent until rows hit a missing
 * relation. Force sync is the full reconcile — it also DROPS tables removed
 * upstream, so it sits behind a type-to-confirm dialog. Auto-heal is
 * CLI-only: `tendb schema config --auto-sync on|off`.
 */
function SchemaCard({ drifted, onChanged }: { drifted: boolean; onChanged: () => void }) {
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  // Fire-and-poll: the sync request returns instantly (oauth2-proxy cuts
  // long-held requests) and we watch the live drift until it reads clean.
  const [syncingSince, setSyncingSince] = useState<number | null>(null);

  const sync = useMutation({
    mutationFn: api.schemaSync,
    onSuccess: () => setSyncingSince(Date.now()),
    onError: (error) =>
      toast.error("Schema sync failed", error instanceof Error ? error.message : String(error)),
  });

  useEffect(() => {
    if (syncingSince === null) return;
    const timer = setInterval(() => {
      void api
        .schemaDrift()
        .then((drift) => {
          if (drift.inSync) {
            setSyncingSince(null);
            onChanged();
            toast.success("Schema in sync", `${((Date.now() - syncingSince) / 1000).toFixed(0)}s`);
          } else if (Date.now() - syncingSince > 150_000) {
            setSyncingSince(null);
            toast.error(
              "Schema sync timed out",
              "check the engine host: journalctl -u tendb-snapshotd",
            );
          }
        })
        .catch(() => {
          // Transient probe failure — keep polling until the deadline.
        });
    }, 3_000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncingSince]);

  return (
    <Card
      label="schema"
      className="mb-6"
      action={
        <span
          className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10.5px] font-medium ${
            drifted ? "bg-warn/15 text-warn" : "bg-accent/15 text-accent-ink"
          }`}
        >
          <span className={`size-1.5 rounded-full ${drifted ? "bg-warn" : "bg-accent"}`} />
          {drifted ? "drifted" : "in sync"}
        </span>
      }
    >
      <div className="flex flex-wrap items-center gap-4">
        <Button
          size="sm"
          variant="danger"
          busy={sync.isPending || syncingSince !== null}
          onClick={() => setConfirming(true)}
        >
          Force schema sync
        </Button>
      </div>
      <p className="mt-2.5 text-[12px] leading-snug text-faint">
        Migrations don't replicate — new tables drift silently until written to. Force sync
        is the full reconcile: it creates tables added upstream and drops tables that were
        removed, along with their data.
      </p>
      <ConfirmDialog
        open={confirming}
        title="Force schema sync"
        description="Full reconcile of the sync target's schema. Tables removed upstream are DROPPED here, including all their data. This cannot be undone."
        confirmLabel="Force sync"
        destructive
        typeToConfirm="approve"
        onConfirm={() => {
          setConfirming(false);
          sync.mutate();
        }}
        onCancel={() => setConfirming(false)}
      />
    </Card>
  );
}

function SlackCard({ configured, onSaved }: { configured: boolean; onSaved: () => void }) {
  const toast = useToast();
  const [url, setUrl] = useState("");

  const save = useMutation({
    mutationFn: (webhookUrl: string) => api.saveSlackWebhook(webhookUrl),
    onSuccess: (result) => {
      setUrl("");
      onSaved();
      toast.success(result.configured ? "Slack webhook saved" : "Slack webhook cleared");
    },
    onError: (error) =>
      toast.error("Save failed", error instanceof Error ? error.message : String(error)),
  });

  const test = useMutation({
    mutationFn: api.testSlack,
    onSuccess: () => toast.success("Test message sent", "check the Slack channel"),
    onError: (error) =>
      toast.error("Test failed", error instanceof Error ? error.message : String(error)),
  });

  return (
    <Card
      label="slack"
      className="mb-6"
      action={
        <span
          className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10.5px] font-medium ${
            configured ? "bg-accent/15 text-accent-ink" : "bg-raised text-faint"
          }`}
        >
          <span className={`size-1.5 rounded-full ${configured ? "bg-accent" : "border border-faint"}`} />
          {configured ? "connected" : "not connected"}
        </span>
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder={configured ? "replace webhook URL (empty saves = disconnect)" : "https://hooks.slack.com/services/…"}
          spellCheck={false}
          className="h-8 min-w-72 flex-1 rounded-md border border-line-strong bg-canvas px-2.5 font-mono text-[12px] text-ink placeholder:text-faint focus:border-accent/60 focus:outline-none"
        />
        <Button
          size="sm"
          variant="primary"
          busy={save.isPending}
          disabled={!url.trim() && !configured}
          onClick={() => save.mutate(url.trim())}
        >
          Save
        </Button>
        <Button size="sm" variant="ghost" busy={test.isPending} disabled={!configured} onClick={() => test.mutate()}>
          Send test
        </Button>
      </div>
      <p className="mt-2.5 text-[12px] leading-snug text-faint">
        A Slack incoming webhook. Alert and recovery transitions post here; the URL is stored
        encrypted in SSM and never sent to the browser.
      </p>
    </Card>
  );
}
