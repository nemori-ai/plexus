import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The gateway serves the built client SAME-ORIGIN at GET /admin (see
// src/core/admin.ts), so the app is built with `base: "/admin/"` and emits to
// `dist/` (which the gateway's static handler reads). There is no standalone dev
// server in normal use — a separate Vite origin would fail the gateway's
// Host/Origin guard (§5b). Build, then load http://127.0.0.1:7077/admin.
export default defineConfig({
  plugins: [react()],
  base: "/admin/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
