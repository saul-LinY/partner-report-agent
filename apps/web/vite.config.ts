import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiProxyTarget = process.env.API_PROXY_TARGET ?? "http://127.0.0.1:4310";

export default defineConfig({
  envDir: "../..",
  plugins: [react()],
  server: {
    port: 4311,
    strictPort: true,
    proxy: {
      "/v1": apiProxyTarget,
      "/auth": apiProxyTarget,
    },
  },
});
