import { Button } from "./Button";
import { AlertIcon } from "./Icons";

/* The branch selector itself now lives in the AppShell sidebar — clone-scoped
   screens share that selection through useSelectedBranch. */

export function NoCloneNotice({ onGoToBranches }: { onGoToBranches: () => void }) {
  return (
    <div className="mb-4 flex items-center gap-3 rounded-lg border border-line bg-panel px-4 py-3">
      <AlertIcon className="size-4 shrink-0 text-warn" />
      <p className="flex-1 text-[13px] text-dim">No clone is ready to accept queries yet.</p>
      <Button size="sm" variant="ghost" onClick={onGoToBranches}>
        Go to branches
      </Button>
    </div>
  );
}
