import { useEffect, useMemo, useRef } from "react";
import CodeMirror, { EditorView, Prec, keymap, oneDark } from "@uiw/react-codemirror";
import { PostgreSQL, sql } from "@codemirror/lang-sql";
import { useTheme } from "../lib/theme";

/**
 * Repaints the editor chrome onto the console's own surfaces. Every value is a
 * theme token, so the one spec serves both palettes; only the `dark` flag and
 * the syntax highlighting differ between the two instances below.
 */
const SURFACE_SPEC = {
  "&": { backgroundColor: "transparent", color: "var(--color-ink)", fontSize: "13px" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.65" },
  ".cm-content": { caretColor: "var(--color-accent-ink)", padding: "12px 0" },
  ".cm-placeholder": { color: "var(--color-faint)" },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--color-faint)",
    border: "none",
    paddingLeft: "4px",
  },
  ".cm-lineNumbers .cm-gutterElement": { minWidth: "2.4ch", paddingRight: "12px" },
  ".cm-activeLine": {
    backgroundColor: "color-mix(in oklab, var(--color-ink) 4%, transparent)",
  },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--color-dim)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--color-accent-ink)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "color-mix(in oklab, var(--color-accent) 24%, transparent)",
  },
  ".cm-selectionMatch": {
    backgroundColor: "color-mix(in oklab, var(--color-accent) 14%, transparent)",
  },
  ".cm-tooltip": {
    backgroundColor: "var(--color-panel)",
    border: "1px solid var(--color-line)",
    borderRadius: "6px",
    color: "var(--color-ink)",
  },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
    backgroundColor: "color-mix(in oklab, var(--color-accent) 16%, transparent)",
    color: "var(--color-ink)",
  },
  ".cm-panels": { backgroundColor: "var(--color-panel)", color: "var(--color-ink)" },
};

const darkSurface = EditorView.theme(SURFACE_SPEC, { dark: true });
const lightSurface = EditorView.theme(SURFACE_SPEC, { dark: false });

// Dark takes oneDark's token palette. Light needs no highlight extension:
// basicSetup already installs defaultHighlightStyle, whose colours are built
// for a light background.
const DARK_THEME = [oneDark, darkSurface];
const LIGHT_THEME = [lightSurface];

export function SqlInput({
  value,
  onChange,
  onRun,
  disabled,
}: {
  value: string;
  onChange: (next: string) => void;
  onRun: () => void;
  disabled: boolean;
}) {
  const { resolved } = useTheme();

  // The keymap extension is built once; a ref keeps it pointing at the latest
  // handler without reconfiguring the editor on every keystroke.
  const runRef = useRef(onRun);
  useEffect(() => {
    runRef.current = onRun;
  }, [onRun]);

  const extensions = useMemo(
    () => [
      Prec.highest(
        keymap.of([
          {
            key: "Mod-Enter",
            preventDefault: true,
            run: () => {
              runRef.current();
              return true;
            },
          },
        ]),
      ),
      sql({ dialect: PostgreSQL, upperCaseKeywords: true }),
      EditorView.lineWrapping,
    ],
    [],
  );

  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      editable={!disabled}
      height="100%"
      className="h-full overflow-hidden"
      theme={resolved === "dark" ? DARK_THEME : LIGHT_THEME}
      extensions={extensions}
      placeholder="select * from orders order by created_at desc limit 50;"
      basicSetup={{
        lineNumbers: true,
        foldGutter: false,
        highlightActiveLine: true,
        highlightActiveLineGutter: true,
        autocompletion: true,
        bracketMatching: true,
        closeBrackets: true,
        searchKeymap: false,
      }}
    />
  );
}
