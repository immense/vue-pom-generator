/**
 * Test ID manifest generator utilities
 * Generates TypeScript types and manifests from collected test IDs
 */

/**
 * Generates the complete virtual:testids module content
 */
export function generateTestIdsModule(componentTestIds: Map<string, Set<string>>): string {
  const manifestEntries = Array.from(componentTestIds.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([c, set]) => `  ${JSON.stringify(c)}: ${JSON.stringify(Array.from(set).sort())}`)
    .join(",\n");

  return `// Virtual module: test id manifest
export const testIdManifest = {
${manifestEntries}
} as const;
export type TestIdManifest = typeof testIdManifest;
export type ComponentName = keyof TestIdManifest;
`;
}
