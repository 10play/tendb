import { Dialog } from "./Dialog";
import { Button } from "./Button";
import { ConnectionUri } from "./ConnectionUri";
import { CopyButton } from "./CopyButton";
import { Spinner } from "./Spinner";
import { useBranchUri } from "../lib/queries";

/**
 * The sidebar's Connect action: pick a branch, get its URIs and the psql
 * one-liner. Branch choice is the same shared selection the clone-scoped
 * screens follow, so connecting and querying always mean the same clone.
 */
export function ConnectDialog({
  open,
  onClose,
  branches,
  branch,
  onPickBranch,
}: {
  open: boolean;
  onClose: () => void;
  branches: string[];
  branch: string;
  onPickBranch: (branch: string) => void;
}) {
  const uri = useBranchUri(branch, open && Boolean(branch));

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Connect to your database"
      description="Every branch is its own Postgres endpoint on the engine host."
      width="max-w-lg"
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      {branches.length === 0 ? (
        <p className="text-[13px] text-dim">
          No clone is ready to accept connections yet. Create a branch first.
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          <div>
            <label htmlFor="connect-branch" className="label-eyebrow mb-1.5 block">
              branch
            </label>
            <select
              id="connect-branch"
              value={branch}
              onChange={(event) => onPickBranch(event.target.value)}
              className="w-full rounded-md border border-line-strong bg-canvas px-3 py-2 font-mono text-[13px] text-ink focus:border-accent/60 focus:outline-none"
            >
              {branches.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </div>

          {uri.isLoading ? (
            <p className="flex items-center gap-2 text-[12.5px] text-dim">
              <Spinner className="size-3.5 text-accent-ink" />
              Fetching connection details…
            </p>
          ) : uri.isError ? (
            <p className="font-mono text-[12px] break-words text-danger">
              {uri.error instanceof Error ? uri.error.message : String(uri.error)}
            </p>
          ) : uri.data ? (
            <>
              <ConnectionUri uri={uri.data.uri} label="connection uri" />
              {uri.data.localUri ? (
                <ConnectionUri uri={uri.data.localUri} label="local uri (via open tunnel)" />
              ) : null}
              <div>
                <div className="label-eyebrow mb-1.5">psql</div>
                <div className="flex items-center gap-2 rounded-md border border-line bg-canvas py-1.5 pr-1.5 pl-2.5">
                  <code className="min-w-0 flex-1 overflow-x-auto font-mono text-[12px] whitespace-nowrap text-dim">
                    tendb psql {branch}
                  </code>
                  <CopyButton value={`tendb psql ${branch}`} />
                </div>
              </div>
            </>
          ) : null}
        </div>
      )}
    </Dialog>
  );
}
