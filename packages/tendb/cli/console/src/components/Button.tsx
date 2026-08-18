import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Spinner } from "./Spinner";

type Variant = "primary" | "accent" | "ghost" | "quiet" | "danger";
type Size = "sm" | "md";

const VARIANTS: Record<Variant, string> = {
  /* Neutral contrast fill — white-on-dark / black-on-light. */
  primary:
    "bg-contrast text-on-contrast font-medium hover:opacity-90 active:opacity-80 disabled:hover:opacity-100",
  /* Green outline, reserved for Connect — the one action that earns the brand colour. */
  accent:
    "border border-accent/50 bg-transparent text-ink font-medium hover:border-accent hover:bg-accent/10 disabled:hover:border-accent/50 disabled:hover:bg-transparent",
  ghost:
    "border border-line-strong bg-transparent text-ink font-medium hover:bg-raised disabled:hover:bg-transparent",
  quiet: "text-dim font-medium hover:text-ink hover:bg-raised",
  danger:
    "border border-line-strong bg-transparent text-danger font-medium hover:border-danger/60 hover:bg-danger/10 disabled:hover:bg-transparent disabled:hover:border-line-strong",
};

const SIZES: Record<Size, string> = {
  sm: "h-7 px-2.5 text-[12.5px] gap-1.5 rounded-md",
  md: "h-8 px-4 text-[13.5px] gap-2 rounded-md",
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  busy?: boolean;
  icon?: ReactNode;
}

export function Button({
  variant = "ghost",
  size = "md",
  busy = false,
  icon,
  children,
  className = "",
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled || busy}
      className={`inline-flex shrink-0 items-center justify-center whitespace-nowrap transition-colors duration-100 disabled:cursor-not-allowed disabled:opacity-45 ${VARIANTS[variant]} ${SIZES[size]} ${className}`}
      {...rest}
    >
      {busy ? <Spinner className="size-3.5" /> : icon}
      {children}
    </button>
  );
}
