import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const src = (pkg: string) =>
  fileURLToPath(new URL(`../../packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  base: "/_/",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      { find: "@heybe/client", replacement: src("client") },
      { find: "@heybe/query", replacement: src("query") },
      { find: /^@heybe\/ui$/, replacement: src("ui") },
    ],
  },
  build: {
    outDir: "../../packages/heybe/ui/dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 1400,
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8090",
      "/_/extensions": "http://127.0.0.1:8090",
    },
  },
});
