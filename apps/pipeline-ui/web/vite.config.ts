import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// Built output goes to apps/pipeline-ui/dist/ (one level up from web/).
// The daemon serves whatever's in that directory.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: resolve(__dirname, "..", "dist"),
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 800,
  },
  server: {
    port: 5173,
    proxy: {
      // During `vite dev`, forward API + SSE to the running daemon.
      // Set VITE_DAEMON_PORT to point at it; defaults to 56981 (test value).
      "/api": {
        target: `http://127.0.0.1:${process.env.VITE_DAEMON_PORT ?? "56981"}`,
        changeOrigin: true,
      },
    },
  },
});
