import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  use: {
    baseURL: "http://127.0.0.1:3011",
    viewport: { width: 1440, height: 900 },
    channel: "msedge",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run start -- --port 3011",
    url: "http://127.0.0.1:3011",
    reuseExistingServer: !process.env.CI,
    timeout: 60000,
  },
});
