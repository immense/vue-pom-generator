/**
 * Test ID manifest generator utilities
 * Generates TypeScript types and manifests from collected test IDs
 */

import { renderTypeScript } from "./typescript-codegen";

/**
 * Generates the complete virtual:testids module content
 */
export function generateTestIdsModule(componentTestIds: Map<string, Set<string>>): string {
  const manifestEntries = Array.from(componentTestIds.entries())
    .sort((a, b) => a[0].localeCompare(b[0]));

  return renderTypeScript((writer) => {
    writer.writeLine("// Virtual module: test id manifest");
    writer.writeLine("export const testIdManifest = {");
    writer.indent(() => {
      for (let i = 0; i < manifestEntries.length; i += 1) {
        const [componentName, testIds] = manifestEntries[i];
        const suffix = i === manifestEntries.length - 1 ? "" : ",";
        writer.writeLine(`${JSON.stringify(componentName)}: ${JSON.stringify(Array.from(testIds).sort())}${suffix}`);
      }
    });
    writer.writeLine("} as const;");
    writer.writeLine("export type TestIdManifest = typeof testIdManifest;");
    writer.writeLine("export type ComponentName = keyof TestIdManifest;");
  });
}
