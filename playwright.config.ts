import { readFileSync } from "node:fs";
import { defineConfig } from "@playwright/test";

const videoDimensions = JSON.parse(
  readFileSync(new URL("./playwright-video-dimensions.json", import.meta.url), "utf8"),
) as {
  height: number;
  width: number;
};

const playwrightVideoSize = {
  width: videoDimensions.width,
  height: videoDimensions.height,
} as const;

export default defineConfig({
  testDir: "./tests/playwright",
  outputDir: "test-results/playwright",
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:4173",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: {
      mode: "on",
      size: playwrightVideoSize,
    },
    viewport: playwrightVideoSize,
  },
  webServer: {
    command: "node ./tests/playwright/serve-fixtures.mjs",
    url: "http://127.0.0.1:4173/tests/playwright/fixtures/pointer-callout/index.html",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
