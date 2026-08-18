import { Button } from "./Button";
import { AlertIcon } from "./Icons";
import { ApiError } from "../lib/api";

/**
 * Shown when the status poll fails. Two causes look identical from here — the
 * console server is gone, or the SSM tunnel to the engine is — so name both and
 * give the command that fixes each.
 */
export function EngineDown({ error, onRetry, retrying }: { error: unknown; onRetry: () => void; retrying: boolean }) {
  const offline = error instanceof ApiError && error.isOffline;
  const message = error instanceof Error ? error.message : String(error);

  return (
    <div className="flex min-h-[60vh] items-center justify-center px-6 py-16">
      <div className="max-w-md text-center">
        <div className="mx-auto mb-5 flex size-11 items-center justify-center rounded-full border border-warn/30 bg-warn/10 text-warn">
          <AlertIcon className="size-5" />
        </div>

        <h1 className="text-[17px] font-semibold text-ink">Engine unreachable</h1>
        <p className="mt-2 text-[13.5px] leading-relaxed text-dim">
          {offline
            ? "The tendb console server stopped responding. Restart it with tendb console."
            : "The console server is up but DBLab did not answer. Check that the tunnel to the engine is still open."}
        </p>

        <pre className="mt-4 overflow-x-auto rounded-md border border-line bg-panel px-3 py-2.5 text-left font-mono text-[11.5px] break-words whitespace-pre-wrap text-faint">
          {message}
        </pre>

        <div className="mt-5 flex justify-center">
          <Button variant="primary" onClick={onRetry} busy={retrying}>
            Try again
          </Button>
        </div>
      </div>
    </div>
  );
}
