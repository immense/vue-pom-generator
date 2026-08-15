// @vitest-environment node
import { describe, expect, it } from "vitest";

import { generateViewObjectModelMethodContent } from "../method-generation";
import { createPomStringPattern } from "../pom-patterns";

describe("alternate generated selectors", () => {
  it("auto-waits for one visible generated candidate before clicking", () => {
    const content = generateViewObjectModelMethodContent(
      "RecordListPage",
      undefined,
      "CreateRecord",
      "button",
      createPomStringPattern("RecordListPage-Create-button", "static", []),
      [createPomStringPattern("RecordListPage-New-button", "static", [])],
      undefined,
      [],
    );

    expect(content).toContain("await this.resolveVisibleTestIdLocator(candidates");
    expect(content).toContain('"clickCreateRecord", "RecordListPage"');
    expect(content).not.toContain("locator.count()");
    expect(content).not.toContain("Failed to click any candidate locator");
  });

  it("uses the same candidate resolution for generated navigation", () => {
    const content = generateViewObjectModelMethodContent(
      "RecordListPage",
      "RecordCreatePage",
      "CreateRecord",
      "button",
      createPomStringPattern("RecordListPage-Create-routerlink", "static", []),
      [createPomStringPattern("RecordListPage-New-routerlink", "static", [])],
      undefined,
      [],
    );

    expect(content).toContain("await this.resolveVisibleTestIdLocator(candidates");
    expect(content).toContain('"goToCreateRecord", "RecordListPage"');
    expect(content).not.toContain("locator.count()");
  });
});

describe("generated checkbox actions", () => {
  it("targets the visible associated label used by custom controls", () => {
    const content = generateViewObjectModelMethodContent(
      "RecordListPage",
      undefined,
      "SelectPage",
      "checkbox",
      createPomStringPattern("RecordListPage-SelectPage-checkbox", "static", []),
      undefined,
      undefined,
      [],
    );

    expect(content).toContain('methodName: "clickSelectPage", preferAssociatedLabel: true');
  });
});

describe("generated radio actions", () => {
  it("targets the visible associated label used by custom controls", () => {
    const content = generateViewObjectModelMethodContent(
      "RadioGroup",
      undefined,
      "OptionByKey",
      "radio",
      createPomStringPattern("RadioGroup-${key}-Option-radio", "parameterized", ["key"]),
      undefined,
      undefined,
      [{ name: "key", type: "string" }],
    );

    expect(content).toContain('methodName: "selectOptionByKey", preferAssociatedLabel: true');
  });
});
