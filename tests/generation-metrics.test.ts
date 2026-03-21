// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { IComponentDependencies, IDataTestId } from "../utils";
import { getGenerationMetrics, isLessRich } from "../plugin/support/generation-metrics";

function makeDeps(testIds: string[], generatedMethodCount = 0): IComponentDependencies {
  const dataTestIdSet = new Set<IDataTestId>(
    testIds.map(testId => ({
      role: "button",
      dataTestId: testId,
      value: testId,
      generatedActionName: `${testId}Action`,
      generatedGetterName: `${testId}Getter`,
    })),
  );

  const generatedMethods = new Map<string, { params: string; argNames: string[] } | null>();
  for (let i = 0; i < generatedMethodCount; i += 1) {
    generatedMethods.set(`Method${i}`, { params: "", argNames: [] });
  }

  return {
    filePath: "/tmp/Test.vue",
    childrenComponentSet: new Set(),
    usedComponentSet: new Set(),
    dataTestIdSet,
    generatedMethods,
  };
}

describe("generation metrics", () => {
  it("treats fewer selectors as less rich even when entry counts match", () => {
    const richer = getGenerationMetrics(new Map([
      ["HomeIndex", makeDeps(["a", "b", "c"], 3)],
      ["SharedDocumentSelectionModal", makeDeps(["d", "e"], 2)],
    ]));

    const smaller = getGenerationMetrics(new Map([
      ["HomeIndex", makeDeps(["a"], 1)],
      ["SharedDocumentSelectionModal", makeDeps([], 0)],
    ]));

    expect(isLessRich(smaller, richer)).toBe(true);
    expect(isLessRich(richer, smaller)).toBe(false);
  });
});
