// Shared temp-project scaffolding for class-generation / typecheck tests.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { renderTypeScriptLines } from '../../typescript-codegen'

export function makeTempRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/**
 * Write `content` to `filePath`, normalizing `.ts`-family files through
 * renderTypeScriptLines (strips the formatting variance the generator handles
 * for us) and creating parent directories.
 */
export function writeFile(filePath: string, content: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const normalizedContent = filePath.endsWith(".ts") || filePath.endsWith(".tsx") || filePath.endsWith(".mts") || filePath.endsWith(".cts") || filePath.endsWith(".d.ts")
    ? renderTypeScriptLines(content.replace(/\r\n/g, "\n").split("\n"))
    : content;
  fs.writeFileSync(filePath, normalizedContent, "utf8");
}

/** Extract the generated source block for one class (up to the next class or EOF). */
export function extractClassBlock(content: string, className: string): string {
  const start = content.indexOf(`export class ${className}`);
  if (start < 0) {
    throw new Error(`Class ${className} not found in generated output.`);
  }

  const next = content.indexOf("export class ", start + 1);
  const end = next >= 0 ? next : content.length;
  return content.slice(start, end);
}
