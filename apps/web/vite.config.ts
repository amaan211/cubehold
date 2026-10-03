import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const API = process.env.CUBEHOLD_API_URL ?? "http://127.0.0.1:4000";

export default defineConfig({
  plugins: [tanstackRouter({ target: "react", autoCodeSplitting: true }), react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/trpc": { target: API, changeOrigin: false },
      "/api": { target: API, changeOrigin: false },
      "/health": { target: API, changeOrigin: false },
      "/ws": { target: API.replace(/^http/, "ws"), ws: true },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
