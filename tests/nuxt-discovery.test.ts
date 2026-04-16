// @vitest-environment node
import { describe, expect, it } from "vitest";

import { resolveNuxtProjectDiscovery } from "../plugin/nuxt-discovery";

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
});
