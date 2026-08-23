import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  envDir: "../..",
  plugins: [react()],
  server: {
    port: 4311,
    strictPort: true,
    proxy: {
      "/v1": "http://127.0.0.1:4310",
      "/auth": "http://127.0.0.1:4310",
    },
  },
});
