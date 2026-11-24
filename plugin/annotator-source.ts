import fs from "node:fs";
import path from "node:path";
import { toPosixSlashes } from "./path-utils";

/** Resolve once from the Vite root, including worktrees whose .git is a file. */
export function resolveAnnotatorSourceRoot(viteRoot: string, sourceRoot?: string): string {
  if (sourceRoot !== undefined) {
    if (typeof sourceRoot !== "string" || !sourceRoot.trim()) {
      throw new Error("[vue-pom-generator] runtime.annotator.sourceRoot must be a non-empty directory path.");
    }
    const root = path.resolve(viteRoot, sourceRoot);
    if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error("[vue-pom-generator] runtime.annotator.sourceRoot must be a directory.");
    }
    return fs.realpathSync(root);
  }

  let root = fs.realpathSync(viteRoot);
  while (!fs.existsSync(path.join(root, ".git"))) {
    const parent = path.dirname(root);
    if (parent === root) {
      throw new Error("[vue-pom-generator] No .git found above the Vite root. Set runtime.annotator.sourceRoot explicitly.");
    }
    root = parent;
  }
  return root;
}

export function annotatorSourcePath(filename: string, sourceRoot: string): string {
  if (!path.isAbsolute(filename) || !path.isAbsolute(sourceRoot)) {
    throw new Error("[vue-pom-generator] Annotator filenames and resolved sourceRoot must be absolute paths.");
  }
  const relative = path.relative(sourceRoot, filename);
  if (path.isAbsolute(relative)) {
    throw new Error("[vue-pom-generator] Annotator source file and sourceRoot must be on the same drive.");
  }
  return toPosixSlashes(relative);
}
