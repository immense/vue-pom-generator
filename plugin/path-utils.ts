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

function safeRealpath(value: string): string {
  try {
    if (fs.existsSync(value)) {
      return fs.realpathSync(value);
    }
  }
  catch {
    return value;
  }

  const parent = path.dirname(value);
  if (!parent || parent === value) {
    return value;
  }

  const resolvedParent = safeRealpath(parent);
  return resolvedParent === parent
    ? value
    : path.join(resolvedParent, path.basename(value));
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
  /** Additional page/component/layout directories relative to projectRoot or absolute. */
  sourceDirs: string[];
  /**
   * Additional root paths to try when resolving configured directories.
   * Pass process.cwd() here for Nuxt 4 compatibility where Vite sets
   * config.root to the app/ subdirectory rather than the web project root.
   */
  extraRoots?: string[];
}

/**
 * Derive a unique PascalCase class name for a Vue component from its file path.
 *
 * Strategy:
 * 1. Build a list of candidate roots from the configured page/component/layout directories.
 * 2. Sort roots longest-first so the most-specific match wins.
 * 3. Relative path from the matching root → toPascalCase → class name.
 * 4. Fallback: just the file's basename (strips .vue).
 *
 * This ensures every index.vue gets a unique name (e.g. AdministrationFirmsIndex)
 * rather than all colliding as "Index".
 */
export function resolveComponentNameFromPath(options: ResolveComponentNameOptions): string {
  const { projectRoot, viewsDirAbs, sourceDirs, extraRoots = [] } = options;

  const cleanFilename = options.filename.includes("?")
    ? options.filename.substring(0, options.filename.indexOf("?"))
    : options.filename;

  const absFilename = path.isAbsolute(cleanFilename)
    ? cleanFilename
    : path.resolve(projectRoot, cleanFilename);
  const normalizedAbsFilename = path.normalize(safeRealpath(absFilename));

  // Build candidate roots from both projectRoot and any extraRoots (e.g. process.cwd() for
  // Nuxt 4 where Vite sets config.root to the app/ subdirectory).
  const rootBases = [projectRoot, ...extraRoots.filter(r => r !== projectRoot)];
  const roots: string[] = [
    viewsDirAbs,
    ...sourceDirs.flatMap(dir => path.isAbsolute(dir) ? [dir] : rootBases.map(base => path.resolve(base, dir))),
  ];

  const potentialRoots = Array.from(new Set(roots.map(r => path.normalize(safeRealpath(r)))))
    .sort((a, b) => b.length - a.length); // longest match first

  for (const root of potentialRoots) {
    if (normalizedAbsFilename.startsWith(root + path.sep) || normalizedAbsFilename === root) {
      const rel = path.relative(root, normalizedAbsFilename);
      const parsed = path.parse(rel);
      const segments = path.join(parsed.dir, parsed.name);
      return toPascalCase(segments);
    }
  }

  // Fallback: use just the filename without extension.
  return toPascalCase(path.parse(normalizedAbsFilename).name);
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
