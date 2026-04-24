import type { Plugin } from "vite";

import type { ElementMetadata } from "../../metadata-collector";
import type { IComponentDependencies } from "../../utils";
import {
  generateWebMcpBridgeModule,
  generatePomManifestModule,
  generateTestIdsModule,
  generateWebMcpManifestModule,
} from "../../manifest-generator";

const TEST_IDS_VIRTUAL_ID = "virtual:testids";
const TEST_IDS_RESOLVED_ID = `\0${TEST_IDS_VIRTUAL_ID}`;
const POM_MANIFEST_VIRTUAL_ID = "virtual:pom-manifest";
const POM_MANIFEST_RESOLVED_ID = `\0${POM_MANIFEST_VIRTUAL_ID}`;
const WEB_MCP_MANIFEST_VIRTUAL_ID = "virtual:webmcp-manifest";
const WEB_MCP_MANIFEST_RESOLVED_ID = `\0${WEB_MCP_MANIFEST_VIRTUAL_ID}`;
const WEB_MCP_BRIDGE_VIRTUAL_ID = "virtual:webmcp-bridge";
const WEB_MCP_BRIDGE_RESOLVED_ID = `\0${WEB_MCP_BRIDGE_VIRTUAL_ID}`;

export function createTestIdsVirtualModulesPlugin(
  componentHierarchyMap: Map<string, IComponentDependencies>,
  elementMetadata: Map<string, Map<string, ElementMetadata>>,
  testIdAttribute: string = "data-testid",
): Plugin {
  return {
    name: "vue-pom-generator:virtual-testids",
    resolveId(id) {
      if (id === TEST_IDS_VIRTUAL_ID)
        return TEST_IDS_RESOLVED_ID;
      if (id === POM_MANIFEST_VIRTUAL_ID)
        return POM_MANIFEST_RESOLVED_ID;
      if (id === WEB_MCP_MANIFEST_VIRTUAL_ID)
        return WEB_MCP_MANIFEST_RESOLVED_ID;
      if (id === WEB_MCP_BRIDGE_VIRTUAL_ID)
        return WEB_MCP_BRIDGE_RESOLVED_ID;
    },
    load(id) {
      if (id === TEST_IDS_RESOLVED_ID)
        return generateTestIdsModule(componentHierarchyMap, elementMetadata);
      if (id === POM_MANIFEST_RESOLVED_ID)
        return generatePomManifestModule(componentHierarchyMap, elementMetadata);
      if (id === WEB_MCP_MANIFEST_RESOLVED_ID)
        return generateWebMcpManifestModule(componentHierarchyMap, elementMetadata);
      if (id === WEB_MCP_BRIDGE_RESOLVED_ID)
        return generateWebMcpBridgeModule(componentHierarchyMap, elementMetadata, testIdAttribute);
    },
  };
}
