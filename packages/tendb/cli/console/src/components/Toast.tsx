import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { CheckIcon, CloseIcon, AlertIcon } from "./Icons";
import { Button } from "./Button";

type ToastTone = "success" | "error";

interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  body?: string;
}

interface ToastApi {
  success: (title: string, body?: string) => void;
  error: (title: string, body?: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const DISMISS_MS = 7_000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback(
    (tone: ToastTone, title: string, body?: string) => {
      const id = nextId.current++;
      setToasts((current) => [...current.slice(-3), { id, tone, title, body }]);
      window.setTimeout(() => dismiss(id), DISMISS_MS);
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      success: (title, body) => push("success", title, body),
      error: (title, body) => push("error", title, body),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        className="pointer-events-none fixed right-5 bottom-5 z-50 flex w-[min(24rem,calc(100vw-2.5rem))] flex-col gap-2"
        role="status"
        aria-live="polite"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className="pointer-events-auto flex items-start gap-2.5 rounded-lg border border-line bg-panel px-3.5 py-3 shadow-xl shadow-shade"
          >
            <span className={toast.tone === "success" ? "text-accent-ink" : "text-danger"}>
              {toast.tone === "success" ? (
                <CheckIcon className="mt-px size-4" />
              ) : (
                <AlertIcon className="mt-px size-4" />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] text-ink">{toast.title}</p>
              {toast.body ? (
                <p className="mt-0.5 font-mono text-[11.5px] leading-snug break-words text-faint">
                  {toast.body}
                </p>
              ) : null}
            </div>
            <Button
              variant="quiet"
              size="sm"
              className="-my-1 -mr-1.5 px-1"
              aria-label="Dismiss"
              onClick={() => dismiss(toast.id)}
              icon={<CloseIcon className="size-3.5" />}
            />
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error("useToast must be used inside ToastProvider");
  return api;
}
