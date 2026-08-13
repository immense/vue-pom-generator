import { describe, expect, it } from "vitest";

import { resolveExistingIdBehavior } from "../plugin/vue-plugin";

describe("resolveExistingIdBehavior", () => {
  it("uses a scalar behavior for every component", () => {
    expect(resolveExistingIdBehavior("preserve", "ImmyRadioGroup")).toBe("preserve");
  });

  it("uses named component overrides and the configured default", () => {
    const config = {
      default: "error" as const,
      components: {
        ImmyRadioGroup: "overwrite" as const,
      },
    };

    expect(resolveExistingIdBehavior(config, "ImmyRadioGroup")).toBe("overwrite");
    expect(resolveExistingIdBehavior(config, "ImmyTabItem")).toBe("error");
  });
});
