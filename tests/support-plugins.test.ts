import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createBuildProcessorPlugin: vi.fn(() => ({ name: "build-plugin" })),
  createDevProcessorPlugin: vi.fn(() => ({ name: "dev-plugin" })),
}));

vi.mock("../plugin/support/build-plugin", () => ({
  createBuildProcessorPlugin: mocks.createBuildProcessorPlugin,
}));

vi.mock("../plugin/support/dev-plugin", () => ({
  createDevProcessorPlugin: mocks.createDevProcessorPlugin,
}));

import { createSupportPlugins } from "../plugin/support-plugins";

describe("createSupportPlugins", () => {
  it("forwards csharp options to the dev processor", () => {
    mocks.createBuildProcessorPlugin.mockClear();
    mocks.createDevProcessorPlugin.mockClear();

    const loggerRef = {
      current: {
        info: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
      },
    };

    createSupportPlugins({
      componentTestIds: new Map(),
      componentHierarchyMap: new Map(),
      vueFilesPathMap: new Map(),
      nativeWrappers: {},
      excludedComponents: [],
      viewsDir: "app/pages",
      scanDirs: ["app"],
      outDir: "generated/pom",
      emitLanguages: ["ts", "csharp"],
      csharp: { namespace: "AylaV2.Tests.Generated" },
      routerAwarePoms: false,
      projectRootRef: { current: "/tmp/project" },
      testIdAttribute: "data-testid",
      loggerRef,
    });

    expect(mocks.createBuildProcessorPlugin).toHaveBeenCalledWith(expect.objectContaining({
      csharp: { namespace: "AylaV2.Tests.Generated" },
    }));

    expect(mocks.createDevProcessorPlugin).toHaveBeenCalledWith(expect.objectContaining({
      csharp: { namespace: "AylaV2.Tests.Generated" },
    }));
  });
});
