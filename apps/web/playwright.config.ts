import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results",
  fullyParallel: true,
  workers: 2,
  use: {
    baseURL: "http://127.0.0.1:4312",
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm run dev -- --port 4312",
    url: "http://127.0.0.1:4312",
    reuseExistingServer: !process.env.CI,
  },
});
