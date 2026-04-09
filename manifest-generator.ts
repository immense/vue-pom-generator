/**
 * Test ID manifest generator utilities
 * Generates TypeScript types and manifests from collected test IDs
 */

import { renderSourceFile, VariableDeclarationKind } from "./typescript-codegen";

/**
 * Generates the complete virtual:testids module content
 */
export function generateTestIdsModule(componentTestIds: Map<string, Set<string>>): string {
  const manifestEntries = Array.from(componentTestIds.entries())
    .sort((a, b) => a[0].localeCompare(b[0]));

  return renderSourceFile("virtual-testids.ts", (sourceFile) => {
    sourceFile.addStatements("// Virtual module: test id manifest");
    sourceFile.addVariableStatement({
      declarationKind: VariableDeclarationKind.Const,
      isExported: true,
      declarations: [{
        name: "testIdManifest",
        initializer: (writer) => {
          writer.write("{").newLine();
          writer.indent(() => {
            manifestEntries.forEach(([componentName, testIds], index) => {
              const suffix = index === manifestEntries.length - 1 ? "" : ",";
              writer.writeLine(`${JSON.stringify(componentName)}: ${JSON.stringify(Array.from(testIds).sort())}${suffix}`);
            });
          });
          writer.write("} as const");
        },
      }],
    });
    sourceFile.addTypeAlias({
      isExported: true,
      name: "TestIdManifest",
      type: "typeof testIdManifest",
    });
    sourceFile.addTypeAlias({
      isExported: true,
      name: "ComponentName",
      type: "keyof TestIdManifest",
    });
  });
}
