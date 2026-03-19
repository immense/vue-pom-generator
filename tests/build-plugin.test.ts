import { describe, expect, it, vi } from "vitest";

import * as classGeneration from "../class-generation";
import { createBuildProcessorPlugin } from "../plugin/support/build-plugin";

interface BuildEndPluginLike {
  buildEnd?: (error?: Error) => void;
}

describe("createBuildProcessorPlugin", () => {
  it("does not generate files when the build ends with an error", () => {
    const generateFilesSpy = vi.spyOn(classGeneration, "generateFiles").mockImplementation(() => Promise.resolve());
    const plugin = createBuildProcessorPlugin({
      componentHierarchyMap: new Map([["HomeIndex", {} as never]]),
      vueFilesPathMap: new Map(),
      basePageClassPath: "/tmp/BasePage.ts",
      normalizedBasePagePath: "/tmp/BasePage.ts",
      outDir: "generated/pom",
      emitLanguages: ["ts", "csharp"],
      projectRootRef: { current: "/tmp/project" },
      loggerRef: { current: { info: vi.fn() } as never },
      testIdAttribute: "data-testid",
      routerAwarePoms: false,
    });

    const buildPlugin = plugin as BuildEndPluginLike | null | undefined;

    if (!buildPlugin || typeof buildPlugin.buildEnd !== "function") {
      throw new Error("Expected a build plugin with a buildEnd hook.");
    }

    buildPlugin.buildEnd(new Error("boom"));

    expect(generateFilesSpy).not.toHaveBeenCalled();
  });
});
