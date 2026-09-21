import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface GeneratedFileOutput {
  filePath: string;
  content: string;
}

const manifestName = ".vue-pom-generator-outputs.json";

interface OutputManifest {
  version: 1;
  files: Record<string, string>;
}

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function readManifest(filePath: string): OutputManifest {
  if (!fs.existsSync(filePath)) {
    return { version: 1, files: {} };
  }
  const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<OutputManifest> | null;
  if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1
    || !("files" in value) || !value.files || typeof value.files !== "object" || Array.isArray(value.files)) {
    throw new Error(`[vue-pom-generator] Invalid output ownership manifest: ${filePath}`);
  }
  for (const [name, digest] of Object.entries(value.files)) {
    // Sibling VTU/fixture directories use relative paths containing "..". Absolute,
    // non-normalized and directory-only entries are never valid output file names.
    if (!name || path.isAbsolute(name) || path.win32.isAbsolute(name) || name.includes("\\") || name.includes("\0") || path.posix.normalize(name) !== name
      || name === "." || name === ".." || name.endsWith("/..") || name.endsWith("/")
      || path.basename(name) === manifestName || typeof digest !== "string" || digest.length !== 64
      || !Array.from(digest).every(character => "0123456789abcdef".includes(character))) {
      throw new Error(`[vue-pom-generator] Invalid output ownership entry in ${filePath}: ${name}`);
    }
  }
  return value as OutputManifest;
}

function assertRegularFile(filePath: string): void {
  const entry = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (entry && !entry.isFile()) {
    throw new Error(`[vue-pom-generator] Refusing to replace or remove a non-regular output file: ${filePath}`);
  }
}

function assertNoSymlinkParents(filePath: string, outDir: string, projectRoot: string): void {
  // Check both output branches below their common ancestor. This permits sibling
  // VTU/fixture directories without following a symlink swapped into either tree.
  const relativeOutput = path.relative(projectRoot, outDir);
  let ancestor = relativeOutput === ".." || relativeOutput.startsWith(`..${path.sep}`) || path.isAbsolute(relativeOutput)
    ? path.dirname(outDir)
    : projectRoot;
  const targetDirectory = path.dirname(filePath);
  while (path.relative(ancestor, targetDirectory) === ".."
    || path.relative(ancestor, targetDirectory).startsWith(`..${path.sep}`)
    || path.isAbsolute(path.relative(ancestor, targetDirectory))) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) {
      throw new Error(`[vue-pom-generator] Output must be on the same filesystem volume as its manifest: ${filePath}`);
    }
    ancestor = parent;
  }
  for (const target of [path.dirname(filePath), outDir]) {
    let directory = target;
    while (directory !== ancestor) {
      if (fs.lstatSync(directory, { throwIfNoEntry: false })?.isSymbolicLink()) {
        throw new Error(`[vue-pom-generator] Refusing to follow an output directory symlink: ${directory}`);
      }
      directory = path.dirname(directory);
    }
  }
}

function writeFile(filePath: string, content: string): void {
  // Keep mtimes and watcher state intact when the emitted bytes did not change.
  // Compare the file itself so removed or externally modified outputs are repaired.
  if (fs.existsSync(filePath) && fs.readFileSync(filePath, "utf8") === content) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, content, { flag: "wx" });
    fs.renameSync(temporaryPath, filePath);
  }
  finally {
    if (fs.existsSync(temporaryPath)) {
      fs.unlinkSync(temporaryPath);
    }
  }
}

/** Publish a complete emission, then prune only unchanged files from the previous emission. */
export function writeGeneratedOutputs(outDir: string, files: GeneratedFileOutput[], sharedFiles: GeneratedFileOutput[], projectRoot = path.dirname(path.resolve(outDir))): void {
  const root = path.resolve(outDir);
  const manifestPath = path.join(root, manifestName);
  assertNoSymlinkParents(manifestPath, root, projectRoot);
  assertRegularFile(manifestPath);
  const previous = readManifest(manifestPath);
  const next: OutputManifest = { version: 1, files: {} };
  const contents = new Map<string, string>();
  for (const file of files) {
    const absolutePath = path.resolve(file.filePath);
    if (contents.has(absolutePath) || absolutePath === manifestPath) {
      throw new Error(`[vue-pom-generator] Duplicate generated output: ${absolutePath}`);
    }
    contents.set(absolutePath, file.content);
    // eslint-disable-next-line no-restricted-syntax -- Normalize filesystem separators for portable JSON, not source-code parsing.
    next.files[path.relative(root, absolutePath).split(path.sep).join("/")] = hash(file.content);
  }

  const obsolete: string[] = [];
  for (const [name, digest] of Object.entries(previous.files)) {
    const absolutePath = path.resolve(root, name);
    if (contents.has(absolutePath)) continue;
    assertNoSymlinkParents(absolutePath, root, projectRoot);
    assertRegularFile(absolutePath);
    if (!fs.existsSync(absolutePath)) continue;
    if (hash(fs.readFileSync(absolutePath, "utf8")) !== digest) {
      throw new Error(`[vue-pom-generator] Obsolete generated file was modified; move or remove it explicitly before regenerating: ${absolutePath}`);
    }
    obsolete.push(absolutePath);
  }
  // .gitattributes has a generator-managed block, but the surrounding file belongs
  // to the consumer. Update it without claiming ownership or deleting it later.
  for (const file of sharedFiles) {
    contents.set(path.resolve(file.filePath), file.content);
  }
  for (const filePath of contents.keys()) {
    assertNoSymlinkParents(filePath, root, projectRoot);
    assertRegularFile(filePath);
  }
  for (const [filePath, content] of contents) writeFile(filePath, content);
  // Never prune on a rendering/validation/write failure. No recursive deletion.
  for (const filePath of obsolete) fs.unlinkSync(filePath);
  writeFile(manifestPath, `${JSON.stringify(next, null, 2)}\n`);
}
