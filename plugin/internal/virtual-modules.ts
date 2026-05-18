import type { Plugin } from "vite";

import type { ElementMetadata } from "../../metadata-collector";
import type { IComponentDependencies } from "../../utils";
import { generatePomManifestModule, generateTestIdsModule } from "../../manifest-generator";

const TEST_IDS_VIRTUAL_ID = "virtual:testids";
const TEST_IDS_RESOLVED_ID = `\0${TEST_IDS_VIRTUAL_ID}`;
const POM_MANIFEST_VIRTUAL_ID = "virtual:pom-manifest";
const POM_MANIFEST_RESOLVED_ID = `\0${POM_MANIFEST_VIRTUAL_ID}`;

export function createTestIdsVirtualModulesPlugin(
  componentHierarchyMap: Map<string, IComponentDependencies>,
  elementMetadata: Map<string, Map<string, ElementMetadata>>,
): Plugin {
  return {
    name: "vue-pom-generator:virtual-testids",
    resolveId(id) {
      if (id === TEST_IDS_VIRTUAL_ID)
        return TEST_IDS_RESOLVED_ID;
      if (id === POM_MANIFEST_VIRTUAL_ID)
        return POM_MANIFEST_RESOLVED_ID;
    },
    load(id) {
      if (id === TEST_IDS_RESOLVED_ID)
        return generateTestIdsModule(componentHierarchyMap, elementMetadata);
      if (id === POM_MANIFEST_RESOLVED_ID)
        return generatePomManifestModule(componentHierarchyMap, elementMetadata);
    },
  };
}
