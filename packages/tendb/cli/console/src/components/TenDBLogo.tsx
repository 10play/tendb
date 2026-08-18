/**
 * 10play brand mark (10play.dev), inlined so the console needs no asset
 * pipeline. Renders with currentColor so it follows the theme.
 * The favicon in console/index.html carries the same mark — keep in sync.
 */

/** The 10play mark (slash + triangle "10" glyph), squared up for tiles/avatars. */
export function TenDBMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 21 20" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden="true">
      <path
        fill="currentColor"
        d="m13.153 10.682-2.343 3.91c-1.167 1.949.233 4.43 2.5 4.43h4.687c2.268 0 3.668-2.481 2.5-4.43l-2.342-3.91c-1.133-1.891-3.868-1.891-5 0zM1.705 18.427C.075 17.52-.484 15.513.457 13.943L7.27 2.57C8.213.999 10.3.46 11.933 1.368c1.63.907 2.189 2.914 1.248 4.485l-6.814 11.37c-.942 1.573-3.03 2.112-4.662 1.204"
      />
    </svg>
  );
}

/** Mark + "ten" lettering; AppShell appends the accent "db" to complete the lockup. */
export function TenDBWordmark({ className }: { className?: string }) {
  return (
    <span className={`flex items-center gap-1.5 ${className ?? ""}`} aria-label="tendb">
      <TenDBMark className="h-[17px] w-[18px]" />
      <span className="text-[17px] leading-none font-semibold tracking-tight">ten</span>
    </span>
  );
}
