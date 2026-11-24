import { test } from "@playwright/test";
import { build } from "esbuild";

/** Opens `fixturePath` before each test, serving the annotator client bundled from source. */
export function useAnnotatorFixture(fixturePath: string) {
  let client: string;

  test.beforeAll(async () => {
    const result = await build({
      entryPoints: ["plugin/runtime/annotator/client.ts"],
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
    });
    client = result.outputFiles[0]!.text;
  });

  test.beforeEach(async ({ page }) => {
    await page.route("**/plugin/runtime/annotator/client.ts", route => route.fulfill({ contentType: "text/javascript", body: client }));
    await page.goto(fixturePath);
  });
}
