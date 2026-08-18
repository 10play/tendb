import { MonitorIcon, MoonIcon, SunIcon } from "./Icons";
import { useTheme, type ThemeMode } from "../lib/theme";

/**
 * A segmented control rather than a cycling button: the preference is
 * three-way, and "match system" is a state you cannot see in a cycler — you
 * would only know you were on it by watching the page change at sunset.
 */
const OPTIONS: Array<{ mode: ThemeMode; label: string; icon: typeof SunIcon }> = [
  { mode: "system", label: "Match system", icon: MonitorIcon },
  { mode: "light", label: "Light", icon: SunIcon },
  { mode: "dark", label: "Dark", icon: MoonIcon },
];

export function ThemeToggle() {
  const { mode, setMode } = useTheme();

  return (
    <div
      role="group"
      aria-label="Color theme"
      className="flex shrink-0 items-center rounded-full border border-line bg-panel p-0.5"
    >
      {OPTIONS.map((option) => {
        const active = option.mode === mode;
        const Icon = option.icon;
        return (
          <button
            key={option.mode}
            type="button"
            onClick={() => setMode(option.mode)}
            aria-pressed={active}
            aria-label={option.label}
            title={option.label}
            className={`flex size-6 items-center justify-center rounded-full transition-colors duration-100 ${
              active ? "bg-raised text-accent-ink" : "text-faint hover:text-ink"
            }`}
          >
            <Icon className="size-3.5" />
          </button>
        );
      })}
    </div>
  );
}
