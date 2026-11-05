// @vitest-environment node
import path from "node:path";

import { describe, expect, it } from "vitest";

import { isFileInConfiguredSourceScope, toPosixSlashes } from "../plugin/path-utils";

describe("isFileInConfiguredSourceScope", () => {
  it("matches mixed-separator Windows paths against cwd-based Nuxt source dirs", () => {
    expect(isFileInConfiguredSourceScope({
      filename: "C:/repo/app/pages/administration/firms/index.vue?vue&type=template",
      projectRoot: "C:\\repo\\app",
      viewsDirAbs: "C:\\repo\\app\\src\\views",
      sourceDirs: ["app/pages", "app/components", "app/layouts"],
      extraRoots: ["C:\\repo"],
      pathImpl: path.win32,
    })).toBe(true);
  });

  it("matches app/* source dirs when the configured root is already the app directory", () => {
    expect(isFileInConfiguredSourceScope({
      filename: "C:\\repo\\app\\pages\\index.vue",
      projectRoot: "C:\\repo\\app",
      viewsDirAbs: "C:\\repo\\app\\src\\views",
      sourceDirs: ["app/pages"],
      pathImpl: path.win32,
    })).toBe(true);
  });
});

describe("toPosixSlashes", () => {
  it("converts Windows separators and leaves posix paths untouched", () => {
    expect(toPosixSlashes("C:\\repo\\shared\\ui\\src\\components\\Foo.vue")).toBe("C:/repo/shared/ui/src/components/Foo.vue");
    expect(toPosixSlashes("/repo/shared/ui/Foo.vue")).toBe("/repo/shared/ui/Foo.vue");
  });
});
