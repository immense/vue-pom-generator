// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { introspectNuxtPages, parseRouterFileFromCwd } from "../router-introspection";
import { renderTypeScriptLines } from "../typescript-codegen";

const fixturesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

function readFixture(fixtureName: string): string {
  return fs.readFileSync(path.join(fixturesDir, fixtureName), "utf8");
}

function writeFile(filePath: string, content: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const normalizedContent = filePath.endsWith(".ts") || filePath.endsWith(".tsx") || filePath.endsWith(".mts") || filePath.endsWith(".cts") || filePath.endsWith(".d.ts")
    ? renderTypeScriptLines(content.replace(/\r\n/g, "\n").split("\n"))
    : content;
  fs.writeFileSync(filePath, normalizedContent, "utf8");
}

function writeTypeScriptFile(filePath: string, lines: string[]) {
  writeFile(filePath, lines.join("\n"));
}

function ensureTempNodeModules(tempRoot: string) {
  // parseRouterFileFromCwd creates an internal Vite server rooted at the router entry folder.
  // For bare imports like "vue-router" to resolve, that folder needs to be able to find a
  // node_modules up its directory chain. Since our temp dir lives in OS tmp, wire in a
  // node_modules symlink pointing back at the frontend workspace.
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  const frontendNodeModules = path.resolve(thisDir, "..", "node_modules");
  const tempNodeModules = path.join(tempRoot, "node_modules");
  if (!fs.existsSync(tempNodeModules)) {
    fs.symlinkSync(frontendNodeModules, tempNodeModules, "dir");
  }
}

function getComponentNamingOptions(tempRoot: string, sourceDirs: string[]) {
  return {
    projectRoot: tempRoot,
    viewsDirAbs: path.join(tempRoot, "src", "views"),
    sourceDirs: ["src/views", ...sourceDirs],
  };
}

describe("parseRouterFileFromCwd", () => {
  it("extracts route name/path maps and route meta (params/query)", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vue-pom-router-"));

    try {
      ensureTempNodeModules(tempRoot);

      // These files are never actually parsed as Vue SFCs during introspection; they are stubbed.
      // But Vite's resolver still expects them to exist on disk.
      const stubViewContent = readFixture("StubView.vue");
      writeFile(path.join(tempRoot, "UsersView.vue"), stubViewContent);
      writeFile(path.join(tempRoot, "ThingsView.vue"), stubViewContent);

      const routerEntry = path.join(tempRoot, "router.ts");
      writeTypeScriptFile(
        routerEntry,
        [
          "import { createMemoryHistory, createRouter } from 'vue-router';",
          "import UsersView from './UsersView.vue';",
          "import ThingsView from './ThingsView.vue';",
          "",
          "export default function makeRouter() {",
          "  return createRouter({",
          "    history: createMemoryHistory(),",
          "    routes: [",
          "      {",
          "        path: '/users/:id',",
          "        name: 'users',",
          "        component: UsersView,",
          "        props: (route) => ({ id: route.params.id, q: route.query.q }),",
          "      },",
          "      {",
          "        path: '/things/:thingId?',",
          "        name: 'things',",
          "        component: ThingsView,",
          "        props: (route) => ({ thingId: route.params.thingId }),",
          "      },",
          "    ],",
          "  });",
          "}",
          "",
        ],
      );

      const result = await parseRouterFileFromCwd(routerEntry);

      // name map is keyed by toPascalCase(route.name)
      expect(result.routeNameMap.get("Users")).toBe("UsersView");
      expect(result.routeNameMap.get("Things")).toBe("ThingsView");

      expect(result.routePathMap.get("/users/:id")).toBe("UsersView");
      expect(result.routePathMap.get("/things/:thingId?")).toBe("ThingsView");

      const usersMeta = result.routeMetaEntries.find(e => e.componentName === "UsersView");
      expect(usersMeta).toBeTruthy();
      expect(usersMeta!.params).toEqual([{ name: "id", optional: false }]);
      expect(usersMeta!.query).toEqual(["q"]);
      expect(usersMeta!.pathTemplate).toContain("__VUE_TESTID_PARAM__id__");

      const thingsMeta = result.routeMetaEntries.find(e => e.componentName === "ThingsView");
      expect(thingsMeta).toBeTruthy();
      expect(thingsMeta!.params).toEqual([{ name: "thingId", optional: true }]);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 120_000);

  it("supports module shims while introspecting the router", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vue-pom-router-shims-"));

    try {
      ensureTempNodeModules(tempRoot);

      const stubViewContent = readFixture("StubView.vue");
      writeFile(path.join(tempRoot, "UsersView.vue"), stubViewContent);

      const routerEntry = path.join(tempRoot, "router.ts");
      writeTypeScriptFile(
        routerEntry,
        [
          "import { createMemoryHistory, createRouter } from 'vue-router';",
          "import UsersView from './UsersView.vue';",
          "import { getAppInsights } from '@/config/app-insights';",
          "import { useAppAlertsStore } from '@/store/pinia/app-alert-store';",
          "import { usePermissionStore } from '@/store/pinia/permission-store';",
          "",
          "export default function makeRouter() {",
          "  getAppInsights()?.startTrackPage?.('Users');",
          "  useAppAlertsStore().clear();",
          "  usePermissionStore().can('users:view');",
          "  return createRouter({",
          "    history: createMemoryHistory(),",
          "    routes: [",
          "      { path: '/users', name: 'users', component: UsersView },",
          "    ],",
          "  });",
          "}",
          "",
        ],
      );

      const result = await parseRouterFileFromCwd(routerEntry, {
        moduleShims: {
          "@/config/app-insights": {
            getAppInsights: () => ({ startTrackPage() {}, stopTrackPage() {} }),
          },
          "@/store/pinia/app-alert-store": ["useAppAlertsStore"],
          "@/store/pinia/permission-store": ["usePermissionStore"],
        },
      });

      expect(result.routeNameMap.get("Users")).toBe("UsersView");
      expect(result.routePathMap.get("/users")).toBe("UsersView");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 120_000);

  it("resolves lazy route components using canonical names derived from file paths", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vue-pom-router-lazy-"));

    try {
      ensureTempNodeModules(tempRoot);

      const stubViewContent = readFixture("StubView.vue");
      writeFile(path.join(tempRoot, "src", "views", "msp-instances", "List.vue"), stubViewContent);
      writeFile(path.join(tempRoot, "src", "views", "denied-domains", "List.vue"), stubViewContent);

      const routerEntry = path.join(tempRoot, "src", "router.ts");
      writeTypeScriptFile(
        routerEntry,
        [
          "import { createMemoryHistory, createRouter } from 'vue-router';",
          "",
          "export default function makeRouter() {",
          "  return createRouter({",
          "    history: createMemoryHistory(),",
          "    routes: [",
          "      {",
          "        path: '/msp-instances',",
          "        name: 'msp-instances',",
          "        component: () => import('@/views/msp-instances/List.vue'),",
          "      },",
          "      {",
          "        path: '/denied-domains',",
          "        name: 'denied-domains',",
          "        component: () => import('@/views/denied-domains/List.vue'),",
          "      },",
          "    ],",
          "  });",
          "}",
          "",
        ],
      );

      const result = await parseRouterFileFromCwd(routerEntry, {
        componentNaming: getComponentNamingOptions(tempRoot, ["src/views/msp-instances"]),
      });

      expect(result.routeNameMap.get("MspInstances")).toBe("List");
      expect(result.routeNameMap.get("DeniedDomains")).toBe("DeniedDomainsList");
      expect(result.routePathMap.get("/msp-instances")).toBe("List");
      expect(result.routePathMap.get("/denied-domains")).toBe("DeniedDomainsList");

      const listMeta = result.routeMetaEntries.find(e => e.componentName === "List");
      const deniedDomainsMeta = result.routeMetaEntries.find(e => e.componentName === "DeniedDomainsList");

      expect(listMeta?.pathTemplate).toBe("/msp-instances");
      expect(deniedDomainsMeta?.pathTemplate).toBe("/denied-domains");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 120_000);

  it("fails fast when module shims use '*' wildcard export names", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vue-pom-router-shims-star-"));

    try {
      ensureTempNodeModules(tempRoot);

      const stubViewContent = readFixture("StubView.vue");
      writeFile(path.join(tempRoot, "UsersView.vue"), stubViewContent);

      const routerEntry = path.join(tempRoot, "router.ts");
      writeTypeScriptFile(
        routerEntry,
        [
          "import { createMemoryHistory, createRouter } from 'vue-router';",
          "import UsersView from './UsersView.vue';",
          "import { getAppInsights } from '@/config/app-insights';",
          "",
          "export default function makeRouter() {",
          "  getAppInsights();",
          "  return createRouter({",
          "    history: createMemoryHistory(),",
          "    routes: [",
          "      { path: '/users', name: 'users', component: UsersView },",
          "    ],",
          "  });",
          "}",
          "",
        ],
      );

      await expect(() =>
        parseRouterFileFromCwd(routerEntry, {
          moduleShims: {
            "@/config/app-insights": ["*"],
          },
        })
      ).rejects.toThrow("does not support '*'");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 120_000);

  it("uses custom Nuxt page directories when deriving route metadata", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vue-pom-router-nuxt-pages-"));

    try {
      const stubViewContent = readFixture("StubView.vue");
      const pageDir = path.join(tempRoot, "app", "views");
      writeFile(path.join(pageDir, "administration", "users", "index.vue"), stubViewContent);
      writeFile(path.join(pageDir, "reports", "[id].vue"), stubViewContent);

      const result = await introspectNuxtPages(tempRoot, {
        pageDirs: [pageDir],
      });

      expect(result.routePathMap.get("/administration/users")).toBe("AdministrationUsersIndex");

      const usersMeta = result.routeMetaEntries.find(entry => entry.componentName === "AdministrationUsersIndex");
      expect(usersMeta?.pathTemplate).toBe("/administration/users");

      const reportMeta = result.routeMetaEntries.find(entry => entry.pathTemplate === "/reports/:id");
      expect(reportMeta?.params).toEqual([{ name: "id", optional: false }]);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
