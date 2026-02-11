import path from "node:path";

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
