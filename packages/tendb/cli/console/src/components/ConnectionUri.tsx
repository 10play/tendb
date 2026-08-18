import { useState } from "react";
import { Button } from "./Button";
import { CopyButton } from "./CopyButton";
import { EyeIcon, EyeOffIcon } from "./Icons";
import { maskUri } from "../lib/format";

/**
 * A connection string carries a live password, so it stays masked until asked
 * for. Copy always copies the real value — revealing is for reading, not for
 * using.
 */
export function ConnectionUri({ uri, label }: { uri: string; label: string }) {
  const [revealed, setRevealed] = useState(false);

  return (
    <div className="min-w-0">
      <div className="label-eyebrow mb-1.5">{label}</div>
      <div className="flex items-center gap-2 rounded-md border border-line bg-canvas py-1.5 pr-1.5 pl-2.5">
        <code className="min-w-0 flex-1 overflow-x-auto font-mono text-[12px] whitespace-nowrap text-dim">
          {revealed ? uri : maskUri(uri)}
        </code>
        <Button
          size="sm"
          variant="quiet"
          className="px-1.5"
          aria-label={revealed ? "Hide password" : "Reveal password"}
          title={revealed ? "Hide password" : "Reveal password"}
          onClick={() => setRevealed((value) => !value)}
          icon={revealed ? <EyeOffIcon className="size-3.5" /> : <EyeIcon className="size-3.5" />}
        />
        <CopyButton value={uri} />
      </div>
    </div>
  );
}
