import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Root is `console/` (the CLI runs `vite build console`). The bundle lands in
// ../dist/console because the console server serves ./console/ relative to
// dist/index.js — emptyOutDir only clears dist/console, so the CLI bundle stays.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "../dist/console",
    emptyOutDir: true,
    target: "es2022",
    chunkSizeWarningLimit: 900,
  },
  server: {
    port: 5273,
    // `vite dev` talks to a running `tendb console --no-open`.
    proxy: { "/api": "http://localhost:4400" },
  },
});
