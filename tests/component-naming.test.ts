// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveComponentNameFromPath } from "../plugin/path-utils";

describe("resolveComponentNameFromPath", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pom-naming-test-"));
    // Mirror a typical Nuxt 4 app/ structure
    fs.mkdirSync(path.join(tmpDir, "app", "pages", "administration", "firms"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "app", "pages", "administration", "tags"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "app", "pages", "home"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "app", "components", "administration"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "app", "layouts"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const resolve = (filename: string) =>
    resolveComponentNameFromPath({
      filename,
      projectRoot: tmpDir,
      viewsDirAbs: path.join(tmpDir, "src", "views"),
      scanDirs: ["app"],
    });

  it("gives index.vue files a unique name derived from the full page path", () => {
    expect(resolve(path.join(tmpDir, "app", "pages", "administration", "firms", "index.vue")))
      .toBe("AdministrationFirmsIndex");
  });

  it("gives a second index.vue at a different path a different name, avoiding collisions", () => {
    expect(resolve(path.join(tmpDir, "app", "pages", "administration", "tags", "index.vue")))
      .toBe("AdministrationTagsIndex");
  });

  it("gives the root index.vue the simple name Index", () => {
    expect(resolve(path.join(tmpDir, "app", "pages", "index.vue")))
      .toBe("Index");
  });

  it("gives a named page file its path-prefixed name", () => {
    expect(resolve(path.join(tmpDir, "app", "pages", "home", "profile.vue")))
      .toBe("HomeProfile");
  });

  it("gives .client.vue components a path-prefixed name including the Client suffix", () => {
    expect(resolve(path.join(tmpDir, "app", "components", "administration", "FirmsGrid.client.vue")))
      .toBe("AdministrationFirmsGridClient");
  });

  it("falls back to file basename when the file is outside all known roots", () => {
    expect(resolve(path.join(tmpDir, "somewhere-else", "MyWidget.vue")))
      .toBe("MyWidget");
  });

  describe("Nuxt 4 compat — projectRoot is the app/ subdir (config.root = app/)", () => {
    // In Nuxt 4, Vite sets config.root to the app/ subdirectory.
    // scanDirs: ['app'] is configured relative to the web/ project root (process.cwd()),
    // so resolveComponentNameFromPath must try extraRoots when projectRoot alone fails.
    const resolveNuxt4 = (filename: string) =>
      resolveComponentNameFromPath({
        filename,
        projectRoot: path.join(tmpDir, "app"), // Simulates config.root = web/app
        viewsDirAbs: path.join(tmpDir, "app", "src", "views"),
        scanDirs: ["app"],
        extraRoots: [tmpDir], // Simulates process.cwd() = web/
      });

    it("names a nested index.vue correctly (AdministrationFirmsIndex)", () => {
      expect(resolveNuxt4(path.join(tmpDir, "app", "pages", "administration", "firms", "index.vue")))
        .toBe("AdministrationFirmsIndex");
    });

    it("names the root index.vue as Index", () => {
      expect(resolveNuxt4(path.join(tmpDir, "app", "pages", "index.vue")))
        .toBe("Index");
    });

    it("names a .client.vue component with its full path prefix", () => {
      expect(resolveNuxt4(path.join(tmpDir, "app", "components", "administration", "FirmsGrid.client.vue")))
        .toBe("AdministrationFirmsGridClient");
    });
  });
});
