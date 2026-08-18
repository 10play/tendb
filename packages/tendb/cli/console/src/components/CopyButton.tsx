import { useEffect, useRef, useState } from "react";
import { Button } from "./Button";
import { CheckIcon, CopyIcon } from "./Icons";
import { copyText } from "../lib/format";

export function CopyButton({
  value,
  label = "Copy",
  size = "sm",
}: {
  value: string;
  label?: string;
  size?: "sm" | "md";
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  return (
    <Button
      size={size}
      variant="ghost"
      onClick={async () => {
        const ok = await copyText(value);
        setCopied(ok);
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), 1_600);
      }}
      icon={copied ? <CheckIcon className="size-3.5 text-accent-ink" /> : <CopyIcon className="size-3.5" />}
    >
      {copied ? "Copied" : label}
    </Button>
  );
}
