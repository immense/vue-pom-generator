import type { Plugin } from "vite";

import { generateTestIdsModule } from "../../manifest-generator";

const VIRTUAL_ID = "virtual:testids";
const RESOLVED_ID = `\0${VIRTUAL_ID}`;

export function createTestIdsVirtualModulesPlugin(componentTestIds: Map<string, Set<string>>): Plugin {
  return {
    name: "vue-pom-generator:virtual-testids",
    resolveId(id) {
      if (id === VIRTUAL_ID)
        return RESOLVED_ID;
    },
    load(id) {
      if (id === RESOLVED_ID)
        return generateTestIdsModule(componentTestIds);
    },
  };
}
