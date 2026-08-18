import { useEffect, useRef, type ReactNode } from "react";
import { Button } from "./Button";
import { CloseIcon } from "./Icons";

/**
 * Native <dialog> so Escape, focus trapping and inertness come from the
 * platform instead of a hand-rolled approximation.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = "max-w-md",
  dismissible = true,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  width?: string;
  dismissible?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (open && !node.open) node.showModal();
    if (!open && node.open) node.close();
  }, [open]);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const onCancel = (event: Event) => {
      event.preventDefault();
      if (dismissible) onClose();
    };
    node.addEventListener("cancel", onCancel);
    return () => node.removeEventListener("cancel", onCancel);
  }, [dismissible, onClose]);

  return (
    <dialog
      ref={ref}
      aria-label={title}
      className={`m-auto w-[calc(100vw-2rem)] ${width}`}
      onMouseDown={(event) => {
        if (dismissible && event.target === ref.current) onClose();
      }}
    >
      <div className="rounded-xl border border-line bg-panel shadow-2xl shadow-shade">
        <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-[15px] font-medium text-ink">{title}</h2>
            {description ? (
              <p className="mt-1 text-[13px] leading-snug text-dim">{description}</p>
            ) : null}
          </div>
          {dismissible ? (
            <Button
              variant="quiet"
              size="sm"
              onClick={onClose}
              aria-label="Close"
              className="-mr-1.5 -mt-1 px-1.5"
              icon={<CloseIcon className="size-4" />}
            />
          ) : null}
        </header>
        {children ? <div className="px-5 py-4">{children}</div> : null}
        {footer ? (
          <footer className="flex justify-end gap-2 border-t border-line px-5 py-3.5">
            {footer}
          </footer>
        ) : null}
      </div>
    </dialog>
  );
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  destructive = false,
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={title}
      description={description}
      dismissible={!busy}
      width="max-w-sm"
      footer={
        <>
          <Button variant="quiet" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={destructive ? "danger" : "primary"}
            onClick={onConfirm}
            busy={busy}
            autoFocus
          >
            {confirmLabel}
          </Button>
        </>
      }
    />
  );
}
