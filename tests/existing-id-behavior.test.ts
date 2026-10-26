import { describe, expect, it } from "vitest";

import { resolveExistingIdBehavior } from "../plugin/vue-plugin";

describe("resolveExistingIdBehavior", () => {
  it("uses a scalar behavior for every component", () => {
    expect(resolveExistingIdBehavior("preserve", "AppRadioGroup")).toBe("preserve");
  });

  it("uses named component overrides and the configured default", () => {
    const config = {
      default: "error" as const,
      components: {
        AppRadioGroup: "overwrite" as const,
      },
    };

    expect(resolveExistingIdBehavior(config, "AppRadioGroup")).toBe("overwrite");
    expect(resolveExistingIdBehavior(config, "AppTabItem")).toBe("error");
  });
});
