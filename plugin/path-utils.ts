import path from "node:path";

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

export function toPosixRelativeImport(fromDirAbs: string, toPathAbs: string): string {
  let rel = path.relative(fromDirAbs, toPathAbs).replace(/\\/g, "/");
  rel = rel.replace(/\.(ts|tsx|mts|cts)$/i, "");
  if (!rel.startsWith(".")) {
    rel = `./${rel}`;
  }
  return rel;
}
