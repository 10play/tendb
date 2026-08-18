import { useCallback, useEffect, useRef, useState } from "react";
import { notifyStoredKey, subscribeStoredKey } from "./storage";

export type ScreenId = "dashboard" | "branches" | "tables" | "sql" | "perf" | "snapshots" | "alerts";

const SCREENS: ScreenId[] = ["dashboard", "branches", "tables", "sql", "perf", "snapshots", "alerts"];

function readHash(): ScreenId {
  const candidate = window.location.hash.replace(/^#\/?/, "");
  return SCREENS.find((screen) => screen === candidate) ?? "dashboard";
}

/** Hash routing keeps the current screen across reloads and the back button. */
export function useHashRoute(): [ScreenId, (screen: ScreenId) => void] {
  const [screen, setScreen] = useState<ScreenId>(readHash);

  useEffect(() => {
    const onChange = () => setScreen(readHash());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  const navigate = useCallback((next: ScreenId) => {
    window.location.hash = `#/${next}`;
    setScreen(next);
  }, []);

  return [screen, navigate];
}

/**
 * State mirrored into localStorage; falls back cleanly in private mode.
 * Instances sharing a key stay in sync: the sidebar's branch selector and the
 * mounted screen both hold the branch key, so a write in one must show in the
 * other without waiting for a remount.
 */
export function useStoredState<T>(key: string, initial: T): [T, (value: T) => void] {
  const initialRef = useRef(initial);
  initialRef.current = initial;

  const read = useCallback((): T => {
    try {
      const raw = window.localStorage.getItem(key);
      return raw === null ? initialRef.current : (JSON.parse(raw) as T);
    } catch {
      return initialRef.current;
    }
  }, [key]);

  const [value, setValue] = useState<T>(read);

  useEffect(() => subscribeStoredKey(key, () => setValue(read())), [key, read]);

  const store = useCallback(
    (next: T) => {
      setValue(next);
      try {
        window.localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // Storage full or blocked — the in-memory value still works.
      }
      notifyStoredKey(key);
    },
    [key],
  );

  return [value, store];
}

/** Re-renders on an interval so relative ages ("3h") stay honest. */
export function useTicker(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}
