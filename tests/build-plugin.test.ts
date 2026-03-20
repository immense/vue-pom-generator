import { afterEach, describe, expect, it, vi } from "vitest";

import * as classGeneration from "../class-generation";
import { createBuildProcessorPlugin } from "../plugin/support/build-plugin";

interface BuildEndPluginLike {
  buildEnd?: (error?: Error) => Promise<void> | void;
}

describe("createBuildProcessorPlugin", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not generate files when the build ends with an error", async () => {
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

    await buildPlugin.buildEnd(new Error("boom"));

    expect(generateFilesSpy).not.toHaveBeenCalled();
  });

  it("does not clobber a richer pass with the same component count but fewer selectors", async () => {
    const generateFilesSpy = vi.spyOn(classGeneration, "generateFiles").mockImplementation(() => Promise.resolve());
    const componentHierarchyMap = new Map([
      ["HomeIndex", { dataTestIdSet: new Set([{ pom: { methodName: "openCreateNewMatter", nativeRole: "button", formattedDataTestId: "HomeIndex-OpenCreateNewMatter-button", params: {} } }]) }],
      ["ProjectsProjectInformationIndex", { dataTestIdSet: new Set([{ pom: { methodName: "goToDocumentSelection", nativeRole: "button", formattedDataTestId: "ProjectsProjectInformationIndex-GoToDocumentSelection-button", params: {} } }]) }],
    ]) as Map<string, any>;

    const plugin = createBuildProcessorPlugin({
      componentHierarchyMap,
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

    await buildPlugin.buildEnd(undefined);
    expect(generateFilesSpy).toHaveBeenCalledTimes(1);

    componentHierarchyMap.set("HomeIndex", { dataTestIdSet: new Set() });
    componentHierarchyMap.set("ProjectsProjectInformationIndex", { dataTestIdSet: new Set([{ pom: { methodName: "goToDocumentSelection", nativeRole: "button", formattedDataTestId: "ProjectsProjectInformationIndex-GoToDocumentSelection-button", params: {} } }]) });

    await buildPlugin.buildEnd(undefined);
    expect(generateFilesSpy).toHaveBeenCalledTimes(1);
  });
});
