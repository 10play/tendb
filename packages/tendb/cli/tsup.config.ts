import { defineConfig } from "tsup";

// Two artifacts from one source tree: the CLI binary (shebang) and the SDK
// entry (typed, no shebang). Only the first config cleans — and `clean` wipes
// dist/console, so the full build stays tsup THEN vite (see package.json).
export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm"],
    target: "node20",
    platform: "node",
    clean: true,
    banner: { js: "#!/usr/bin/env node" },
    // All runtime deps stay external (they're regular dependencies) — bundling
    // CJS packages into ESM breaks on esbuild's dynamic-require shim.
  },
  {
    entry: ["src/sdk.ts"],
    format: ["esm"],
    target: "node20",
    platform: "node",
    dts: true,
  },
]);
