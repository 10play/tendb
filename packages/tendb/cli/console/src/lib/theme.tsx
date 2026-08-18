import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { storageKeys } from "./storage";

export type ThemeMode = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_MODES: ThemeMode[] = ["system", "light", "dark"];

const DARK_QUERY = "(prefers-color-scheme: dark)";

/** Page background per theme, mirrored into <meta name="theme-color">. */
const THEME_COLOR: Record<ResolvedTheme, string> = {
  dark: "#161616",
  light: "#fafafa",
};

function readStoredMode(): ThemeMode {
  try {
    const raw = window.localStorage.getItem(storageKeys.theme);
    if (!raw) return "system";
    const parsed = JSON.parse(raw) as unknown;
    return THEME_MODES.includes(parsed as ThemeMode) ? (parsed as ThemeMode) : "system";
  } catch {
    return "system";
  }
}

interface ThemeApi {
  /** What the user chose, including "system". */
  mode: ThemeMode;
  /** What is actually on screen right now. */
  resolved: ResolvedTheme;
  setMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeApi | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(readStoredMode);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia(DARK_QUERY).matches);

  // In "system" mode the OS can change under us — follow it live rather than
  // only reading the preference at startup.
  useEffect(() => {
    const query = window.matchMedia(DARK_QUERY);
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const resolved: ResolvedTheme = mode === "system" ? (systemDark ? "dark" : "light") : mode;

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", resolved === "dark");
    root.classList.toggle("light", resolved === "light");
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", THEME_COLOR[resolved]);
  }, [resolved]);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    try {
      window.localStorage.setItem(storageKeys.theme, JSON.stringify(next));
    } catch {
      // Storage blocked — the choice still applies for this session.
    }
  }, []);

  const value = useMemo<ThemeApi>(() => ({ mode, resolved, setMode }), [mode, resolved, setMode]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeApi {
  const api = useContext(ThemeContext);
  if (!api) throw new Error("useTheme must be used inside ThemeProvider");
  return api;
}
