import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeGeneratedOutputs } from "../plugin/generated-outputs";

describe("generated output ownership", () => {
  let root: string;
  let outDir: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pom-ownership-"));
    outDir = path.join(root, "poms");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const file = (filePath: string, content = "generated") => ({ filePath, content });

  it("preserves files and the ownership manifest when all emitted bytes are unchanged", () => {
    const output = path.join(outDir, "Current.g.ts");
    const shared = path.join(outDir, ".gitattributes");
    const manifest = path.join(outDir, ".vue-pom-generator-outputs.json");
    writeGeneratedOutputs(outDir, [file(output)], [file(shared)]);
    const oldTime = new Date("2020-01-01T00:00:00Z");
    for (const name of [output, shared, manifest]) fs.utimesSync(name, oldTime, oldTime);
    const writes = vi.spyOn(fs, "writeFileSync");
    const renames = vi.spyOn(fs, "renameSync");
    writeGeneratedOutputs(outDir, [file(output)], [file(shared)]);
    expect(writes).not.toHaveBeenCalled();
    expect(renames).not.toHaveBeenCalled();
    for (const name of [output, shared, manifest]) expect(fs.statSync(name).mtime).toEqual(oldTime);

    writeGeneratedOutputs(outDir, [file(output, "updated")], [file(shared)]);
    expect(renames.mock.calls.map(([, destination]) => destination)).toEqual([output, manifest]);
    expect(fs.statSync(shared).mtime).toEqual(oldTime);
  });

  it("prunes previous outputs across directories, never unknown neighbors or shared files", () => {
    const stale = path.join(outDir, "Old.g.ts");
    const vtu = path.join(root, "unit", "Old.vtu.g.ts");
    const fixture = path.join(root, "fixtures.ts");
    const attributes = path.join(outDir, ".gitattributes");
    writeGeneratedOutputs(outDir, [file(stale), file(vtu), file(fixture)], [file(attributes, "handwritten\n")]);
    const handwritten = path.join(outDir, "custom.ts");
    const untrackedGenerated = path.join(outDir, "Unknown.g.ts");
    fs.writeFileSync(handwritten, "keep");
    fs.writeFileSync(untrackedGenerated, "keep");

    writeGeneratedOutputs(outDir, [file(path.join(outDir, "New.g.ts"))], []);

    for (const previous of [stale, vtu, fixture]) expect(fs.existsSync(previous)).toBe(false);
    for (const preserved of [handwritten, untrackedGenerated, attributes]) expect(fs.existsSync(preserved)).toBe(true);
    expect(fs.readFileSync(attributes, "utf8")).toBe("handwritten\n");
  });

  it("fails before writing or pruning if an obsolete file was edited", () => {
    const stale = path.join(outDir, "Old.g.ts");
    const current = path.join(outDir, "index.ts");
    writeGeneratedOutputs(outDir, [file(stale), file(current, "before")], []);
    const manifest = fs.readFileSync(path.join(outDir, ".vue-pom-generator-outputs.json"), "utf8");
    fs.writeFileSync(stale, "manual edit");

    expect(() => writeGeneratedOutputs(outDir, [file(current, "after")], [])).toThrow("was modified");
    expect(fs.readFileSync(current, "utf8")).toBe("before");
    expect(fs.readFileSync(stale, "utf8")).toBe("manual edit");
    expect(fs.readFileSync(path.join(outDir, ".vue-pom-generator-outputs.json"), "utf8")).toBe(manifest);
  });

  it("does not prune or replace the manifest after a write failure", () => {
    const stale = path.join(outDir, "Old.g.ts");
    writeGeneratedOutputs(outDir, [file(stale)], []);
    const manifest = fs.readFileSync(path.join(outDir, ".vue-pom-generator-outputs.json"), "utf8");
    const blocker = path.join(root, "not-a-directory");
    fs.writeFileSync(blocker, "keep");
    expect(() => writeGeneratedOutputs(outDir, [file(path.join(blocker, "index.ts"))], [])).toThrow();
    expect(fs.existsSync(stale)).toBe(true);
    expect(fs.readFileSync(path.join(outDir, ".vue-pom-generator-outputs.json"), "utf8")).toBe(manifest);
  });

  it("accepts previously owned files already removed by the consumer", () => {
    const stale = path.join(outDir, "Old.g.ts");
    writeGeneratedOutputs(outDir, [file(stale)], []);
    fs.unlinkSync(stale);
    expect(() => writeGeneratedOutputs(outDir, [], [])).not.toThrow();
  });

  it("rejects symlink outputs without touching their target", () => {
    const target = path.join(root, "target.ts");
    const output = path.join(outDir, "Output.g.ts");
    fs.mkdirSync(outDir);
    fs.writeFileSync(target, "keep");
    fs.symlinkSync(target, output);
    expect(() => writeGeneratedOutputs(outDir, [file(output)], [])).toThrow("non-regular");
    expect(fs.readFileSync(target, "utf8")).toBe("keep");
  });

  it("rejects a symlinked parent when pruning, including sibling output directories", () => {
    const directory = path.join(root, "unit");
    const output = path.join(directory, "Output.vtu.g.ts");
    writeGeneratedOutputs(outDir, [file(output)], []);
    const moved = path.join(root, "moved");
    fs.renameSync(directory, moved);
    fs.symlinkSync(moved, directory);
    expect(() => writeGeneratedOutputs(outDir, [], [])).toThrow("directory symlink");
    expect(fs.readFileSync(path.join(moved, "Output.vtu.g.ts"), "utf8")).toBe("generated");
  });

  it("rejects a dangling symlink before replacing an output", () => {
    fs.mkdirSync(outDir);
    const output = path.join(outDir, "Output.g.ts");
    fs.symlinkSync(path.join(root, "missing.ts"), output);
    expect(() => writeGeneratedOutputs(outDir, [file(output)], [])).toThrow("non-regular");
    expect(fs.lstatSync(output).isSymbolicLink()).toBe(true);
  });

  it("rejects a replaced shared output ancestor below the project root", () => {
    const shared = path.join(root, "generated");
    outDir = path.join(shared, "playwright");
    const output = path.join(shared, "unit", "Output.vtu.g.ts");
    writeGeneratedOutputs(outDir, [file(output)], [], root);
    const moved = path.join(root, "moved");
    fs.renameSync(shared, moved);
    fs.symlinkSync(moved, shared);
    expect(() => writeGeneratedOutputs(outDir, [], [], root)).toThrow("directory symlink");
    expect(fs.readFileSync(path.join(moved, "unit", "Output.vtu.g.ts"), "utf8")).toBe("generated");
  });

  it.each(["/absolute.ts", "./relative.ts", "directory/../file.ts", "..", ".vue-pom-generator-outputs.json"])(
    "rejects invalid ownership entries (%s)", (entry) => {
      fs.mkdirSync(outDir);
      fs.writeFileSync(path.join(outDir, ".vue-pom-generator-outputs.json"), JSON.stringify({ version: 1, files: { [entry]: "0".repeat(64) } }));
      expect(() => writeGeneratedOutputs(outDir, [], [])).toThrow("Invalid output ownership entry");
    },
  );

  it("rejects malformed ownership data and duplicate destinations", () => {
    const output = path.join(outDir, "index.ts");
    expect(() => writeGeneratedOutputs(outDir, [file(output), file(output)], [])).toThrow("Duplicate");
    fs.mkdirSync(outDir);
    fs.writeFileSync(path.join(outDir, ".vue-pom-generator-outputs.json"), '{"version":2,"files":[]}');
    expect(() => writeGeneratedOutputs(outDir, [], [])).toThrow("Invalid output ownership manifest");
  });
});
