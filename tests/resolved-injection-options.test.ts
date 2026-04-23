// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  applyNuxtDiscoveryToInjectionOptions,
  resolveInjectionSupportOptions,
} from "../plugin/resolved-injection-options";

describe("resolved injection options", () => {
  it("resolves the standard Vue defaults into one support shape", () => {
    expect(resolveInjectionSupportOptions({})).toEqual({
      pageDirs: ["src/views"],
      componentDirs: ["src/components"],
      layoutDirs: ["src/layouts"],
      wrapperSearchRoots: [],
      nativeWrappers: {},
      excludedComponents: [],
      existingIdBehavior: "error",
      testIdAttribute: "data-testid",
    });
  });

  it("starts from Nuxt defaults and applies discovered directories", () => {
    const resolved = resolveInjectionSupportOptions({
      isNuxt: true,
      excludedComponents: ["IgnoredButton"],
      testIdAttribute: "  ",
    });

    expect(resolved).toEqual({
      pageDirs: ["app/pages"],
      componentDirs: ["app/components"],
      layoutDirs: ["app/layouts"],
      wrapperSearchRoots: [],
      nativeWrappers: {},
      excludedComponents: ["IgnoredButton"],
      existingIdBehavior: "error",
      testIdAttribute: "data-testid",
    });

    expect(applyNuxtDiscoveryToInjectionOptions(resolved, {
      rootDir: "/project",
      srcDir: "/project/app",
      pageDirs: [],
      componentDirs: ["/project/app/components", "/project/layer/components"],
      layoutDirs: ["/project/app/layouts"],
      wrapperSearchRoots: ["/project/shared-wrappers"],
    })).toEqual({
      pageDirs: ["/project/app/pages"],
      componentDirs: ["/project/app/components", "/project/layer/components"],
      layoutDirs: ["/project/app/layouts"],
      wrapperSearchRoots: ["/project/shared-wrappers"],
      nativeWrappers: {},
      excludedComponents: ["IgnoredButton"],
      existingIdBehavior: "error",
      testIdAttribute: "data-testid",
    });
  });
});
