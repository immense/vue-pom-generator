import fs from "node:fs";
import path from "node:path";

import { toPascalCase } from "../utils";

function toPosixSlashes(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    out += ch === "\\" ? "/" : ch;
  }
  return out;
}

export function isPathWithinDir(filePathAbs: string, dirPathAbs: string): boolean {
  const fileAbs = path.resolve(filePathAbs);
  const dirAbs = path.resolve(dirPathAbs);

  // Same directory (or file directly in it) should be considered contained.
  const rel = path.relative(dirAbs, fileAbs);

  // On Windows, path.relative can return paths with backslashes; we only care about prefix semantics.
  if (!rel)
    return true;

  // If rel starts with '..' (or is absolute), it's outside.
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

export interface ResolveComponentNameOptions {
  /** Absolute or project-relative path to the .vue file (Vite query params are stripped). */
  filename: string;
  projectRoot: string;
  /** Absolute path to the views directory (e.g. src/views). */
  viewsDirAbs: string;
  /** Scan directories relative to projectRoot (e.g. ["app", "src"]). */
  scanDirs: string[];
  /**
   * Additional root paths to try when resolving scanDirs.
   * Pass process.cwd() here for Nuxt 4 compatibility where Vite sets
   * config.root to the app/ subdirectory rather than the web project root.
   */
  extraRoots?: string[];
}

/**
 * Derive a unique PascalCase class name for a Vue component from its file path.
 *
 * Strategy:
 * 1. Build a list of candidate roots: viewsDir, each scanDir, and conventional
 *    subdirectories (pages/, components/) found inside each scanDir.
 * 2. Sort roots longest-first so the most-specific match wins.
 * 3. Relative path from the matching root → toPascalCase → class name.
 * 4. Fallback: just the file's basename (strips .vue).
 *
 * This ensures every index.vue gets a unique name (e.g. AdministrationFirmsIndex)
 * rather than all colliding as "Index".
 */
export function resolveComponentNameFromPath(options: ResolveComponentNameOptions): string {
  const { projectRoot, viewsDirAbs, scanDirs, extraRoots = [] } = options;

  const cleanFilename = options.filename.includes("?")
    ? options.filename.substring(0, options.filename.indexOf("?"))
    : options.filename;

  const absFilename = path.isAbsolute(cleanFilename)
    ? cleanFilename
    : path.resolve(projectRoot, cleanFilename);

  // Build candidate roots from both projectRoot and any extraRoots (e.g. process.cwd() for
  // Nuxt 4 where Vite sets config.root to the app/ subdirectory).
  const rootBases = [projectRoot, ...extraRoots.filter(r => r !== projectRoot)];
  const roots: string[] = [viewsDirAbs, ...rootBases.flatMap(base => scanDirs.map(d => path.resolve(base, d)))];

  // Add conventional Nuxt/Vue subdirectories (pages/, components/) as roots so that
  // e.g. app/pages/administration/firms/index.vue → AdministrationFirmsIndex
  // instead of PagesAdministrationFirmsIndex.
  for (const base of rootBases) {
    for (const dir of scanDirs) {
      const absDir = path.resolve(base, dir);
      try {
        const pagesDir = path.join(absDir, "pages");
        if (fs.existsSync(pagesDir))
          roots.push(pagesDir);

        const componentsDir = path.join(absDir, "components");
        if (fs.existsSync(componentsDir))
          roots.push(componentsDir);
      }
      catch {
        // Ignore fs errors — directory may not exist on this machine.
      }
    }
  }

  const potentialRoots = Array.from(new Set(roots.map(r => path.normalize(r))))
    .sort((a, b) => b.length - a.length); // longest match first

  for (const root of potentialRoots) {
    if (absFilename.startsWith(root + path.sep) || absFilename === root) {
      const rel = path.relative(root, absFilename);
      const parsed = path.parse(rel);
      const segments = path.join(parsed.dir, parsed.name);
      return toPascalCase(segments);
    }
  }

  // Fallback: use just the filename without extension.
  return toPascalCase(path.parse(absFilename).name);
}

export function toPosixRelativeImport(fromDirAbs: string, toPathAbs: string): string {
  let rel = toPosixSlashes(path.relative(fromDirAbs, toPathAbs));
  const ext = path.extname(rel).toLowerCase();
  if (ext === ".ts" || ext === ".tsx" || ext === ".mts" || ext === ".cts") {
    rel = rel.slice(0, -ext.length);
  }
  if (!rel.startsWith(".")) {
    rel = `./${rel}`;
  }
  return rel;
}
