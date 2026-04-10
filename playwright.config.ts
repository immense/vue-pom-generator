import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/playwright",
  outputDir: "test-results/playwright",
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:4173",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "on",
    viewport: {
      width: 1280,
      height: 720,
    },
  },
  webServer: {
    command: "node ./tests/playwright/serve-fixtures.mjs",
    url: "http://127.0.0.1:4173/tests/playwright/fixtures/pointer-callout/index.html",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
