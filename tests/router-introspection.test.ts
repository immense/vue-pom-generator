// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseRouterFileFromCwd } from "../router-introspection";

const fixturesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

function readFixture(fixtureName: string): string {
  return fs.readFileSync(path.join(fixturesDir, fixtureName), "utf8");
}

function writeFile(filePath: string, content: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

describe("parseRouterFileFromCwd", () => {
  it("extracts route name/path maps and route meta (params/query)", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vue-pom-router-"));

    try {

    // parseRouterFileFromCwd creates an internal Vite server rooted at the router entry folder.
    // For bare imports like "vue-router" to resolve, that folder needs to be able to find a
    // node_modules up its directory chain. Since our temp dir lives in OS tmp, wire in a
    // node_modules symlink pointing back at the frontend workspace.
    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    const frontendNodeModules = path.resolve(thisDir, "..", "..", "..", "node_modules");
    const tempNodeModules = path.join(tempRoot, "node_modules");
    if (!fs.existsSync(tempNodeModules)) {
      fs.symlinkSync(frontendNodeModules, tempNodeModules, "dir");
    }

      // These files are never actually parsed as Vue SFCs during introspection; they are stubbed.
      // But Vite's resolver still expects them to exist on disk.
      const stubViewContent = readFixture("StubView.vue");
      writeFile(path.join(tempRoot, "UsersView.vue"), stubViewContent);
      writeFile(path.join(tempRoot, "ThingsView.vue"), stubViewContent);

      const routerEntry = path.join(tempRoot, "router.ts");
      writeFile(
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
        ].join("\n"),
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
  });
});
