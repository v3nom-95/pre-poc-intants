import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 30000,
  webServer: {
    command: "npx serve out -p 4173",
    url: "http://localhost:4173",
    reuseExistingServer: true,
    timeout: 60000,
  },
  use: {
    baseURL: "http://localhost:4173",
  },
});
