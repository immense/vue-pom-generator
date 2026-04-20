// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadNuxtProjectDiscovery, resolveNuxtProjectDiscovery } from "../plugin/nuxt-discovery";

describe("resolveNuxtProjectDiscovery", () => {
  it("derives custom page dirs and automatic component dirs from resolved Nuxt config", () => {
    const discovery = resolveNuxtProjectDiscovery({
      rootDir: "/project",
      srcDir: "/project/app",
      dir: {
        pages: "views",
        layouts: "shells",
      },
      components: [
        { path: "~/components" },
        { path: "../shared/components" },
      ],
    }, ({ options }) => {
      expect(options.rootDir).toBe("/project");
      return [{
        root: "/project/",
        app: "/project/app/",
        appPages: "/project/app/views/",
        appLayouts: "/project/app/shells/",
      }];
    }, "/project");

    expect(discovery.rootDir).toBe("/project");
    expect(discovery.srcDir).toBe("/project/app");
    expect(discovery.pageDirs).toEqual(["/project/app/views"]);
    expect(discovery.layoutDirs).toEqual(["/project/app/shells"]);
    expect(discovery.componentDirs).toEqual([
      "/project/app/components",
      "/project/shared/components",
    ]);
    expect(discovery.wrapperSearchRoots).toEqual([]);
  });

  it("loads @nuxt/kit from the target project cwd when available locally", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vue-pom-generator-nuxt-load-"));

    try {
      fs.writeFileSync(
        path.join(projectRoot, "package.json"),
        JSON.stringify({ name: "nuxt-load-fixture", private: true }),
        "utf8",
      );

      const nuxtKitDir = path.join(projectRoot, "node_modules", "@nuxt", "kit");
      fs.mkdirSync(nuxtKitDir, { recursive: true });
      fs.writeFileSync(
        path.join(nuxtKitDir, "package.json"),
        JSON.stringify({
          name: "@nuxt/kit",
          type: "module",
          exports: "./index.js",
        }),
        "utf8",
      );
      fs.writeFileSync(
        path.join(nuxtKitDir, "index.js"),
        [
          "export async function loadNuxtConfig({ cwd }) {",
          "  return {",
          "    rootDir: cwd,",
          "    srcDir: `${cwd}/app`,",
          "    dir: { pages: 'custom-pages', layouts: 'custom-layouts' },",
          "    components: [{ path: '~/components' }],",
          "  };",
          "}",
          "export function getLayerDirectories(nuxt) {",
          "  return [{",
          "    root: `${nuxt.options.rootDir}/`,",
          "    app: `${nuxt.options.srcDir}/`,",
          "    appPages: `${nuxt.options.srcDir}/${nuxt.options.dir?.pages ?? 'pages'}/`,",
          "    appLayouts: `${nuxt.options.srcDir}/${nuxt.options.dir?.layouts ?? 'layouts'}/`,",
          "  }];",
          "}",
        ].join("\n"),
        "utf8",
      );

      const discovery = await loadNuxtProjectDiscovery(projectRoot);

      expect(discovery.rootDir).toBe(projectRoot);
      expect(discovery.srcDir).toBe(path.join(projectRoot, "app"));
      expect(discovery.pageDirs).toEqual([path.join(projectRoot, "app", "custom-pages")]);
      expect(discovery.layoutDirs).toEqual([path.join(projectRoot, "app", "custom-layouts")]);
      expect(discovery.componentDirs).toEqual([path.join(projectRoot, "app", "components")]);
      expect(discovery.wrapperSearchRoots).toEqual([]);
    }
    finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
