import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { FindingCode, FindingSeverity } from "../monitor/checkup.js";
import type { AlertEvent } from "../monitor/slack.js";

/**
 * Disk persistence for the console's alert loop: the event ring buffer and the
 * seen-severities map. Restoring `seen` on start is what prevents the Slack
 * re-alert storm — without it every restart re-announces all active findings.
 * Inert when no directory is configured (local `tendb console` runs).
 */

const HISTORY_CAP = 200;

interface PersistedAlertState {
  version: 1;
  savedAt: string;
  seen: [FindingCode, FindingSeverity][];
  history: AlertEvent[];
}

export class AlertStateStore {
  private readonly file: string | null;
  /** Serialized {seen, history} of the last write — savedAt excluded so an
   *  unchanged state never rewrites the file. */
  private lastCore: string | null = null;

  constructor(dir: string | undefined) {
    this.file = dir ? join(dir, "alerts.json") : null;
  }

  async load(): Promise<{
    seen: Map<FindingCode, FindingSeverity>;
    history: AlertEvent[];
  } | null> {
    if (!this.file) return null;
    try {
      const raw = await readFile(this.file, "utf8");
      const state = JSON.parse(raw) as Partial<PersistedAlertState>;
      if (state.version !== 1 || !Array.isArray(state.seen) || !Array.isArray(state.history)) {
        return null;
      }
      const seen = new Map(state.seen);
      const history = state.history.slice(-HISTORY_CAP);
      this.lastCore = JSON.stringify({ seen: [...seen.entries()], history });
      return { seen, history };
    } catch {
      // Missing or corrupt file — start fresh rather than fail the console.
      return null;
    }
  }

  /** Atomic (tmp+rename), deduplicated, and never throws — a full disk must
   *  not kill the alert loop. */
  async save(seen: Map<FindingCode, FindingSeverity>, history: AlertEvent[]): Promise<void> {
    if (!this.file) return;
    const core = {
      seen: [...seen.entries()],
      history: history.slice(-HISTORY_CAP),
    };
    const coreRaw = JSON.stringify(core);
    if (coreRaw === this.lastCore) return;
    const state: PersistedAlertState = {
      version: 1,
      savedAt: new Date().toISOString(),
      ...core,
    };
    try {
      await mkdir(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp-${process.pid}`;
      await writeFile(tmp, JSON.stringify(state), "utf8");
      await rename(tmp, this.file);
      this.lastCore = coreRaw;
    } catch {
      // Best effort; retried on the next transition.
    }
  }
}
