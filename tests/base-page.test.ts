// @vitest-environment node
import { describe, expect, it } from "vitest";

import { BasePage } from "../class-generation/base-page";

describe("BasePage", () => {
  it("exposes page.screencast through a getter", () => {
    const screencast = { path: "/tmp/demo.webm" };
    const page = { screencast } as any;

    const basePage = new BasePage(page);

    expect(basePage.screencast).toBe(screencast);
  });
});
