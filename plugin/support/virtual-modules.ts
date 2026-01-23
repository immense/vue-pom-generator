import type { PluginOption } from "vite";
import virtualImport from "vite-plugin-virtual";

import { generateTestIdsModule } from "../../manifest-generator";

export function createTestIdsVirtualModulesPlugin(componentTestIds: Map<string, Set<string>>): PluginOption {
  // vite-plugin-virtual has different interop shapes across bundlers; support both.
  const maybeModule = virtualImport as { default?: typeof virtualImport };
  const virtual = maybeModule.default ?? virtualImport;

  return virtual({
    "virtual:testids": () => generateTestIdsModule(componentTestIds),
  });
}
