// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compile } from "@vue/compiler-dom";
import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { generateFiles, type GenerateFilesOptions } from "../class-generation";
import { createTestIdTransform } from "../transform";
import { TypeScriptRenderCache } from "../typescript-codegen";
import type { IComponentDependencies } from "../utils";
import { resetWrapperContractCaches } from "../wrapper-contract";

describe("incremental POM rendering", () => {
  let root: string;
  let options: GenerateFilesOptions;
  let hierarchy: Map<string, IComponentDependencies>;
  let paths: Map<string, string>;
  const basePage = path.resolve("class-generation/base-page.ts");

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pom-incremental-"));
    hierarchy = new Map();
    paths = new Map();
    options = {
      projectRoot: root,
      outDir: path.join(root, "playwright"),
      vueTestUtilsOutDir: path.join(root, "unit"),
      typescriptOutputStructure: "split",
      emitLanguages: ["ts", "csharp"],
      generateFixtures: true,
      renderCache: new TypeScriptRenderCache(),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetWrapperContractCaches();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function component(name: string, template: string, isView = false) {
    const filename = path.join(root, "src", isView ? "views" : "components", `${name}.vue`);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, `<template>${template}</template>`);
    paths.set(name, filename);
    hierarchy.delete(name);
    resetWrapperContractCaches();
    compile(template, {
      filename,
      nodeTransforms: [createTestIdTransform(name, hierarchy, {}, [], path.join(root, "src/views"), {
        existingIdBehavior: "error",
        vueFilesPathMap: paths,
      })],
    });
  }

  const emit = () => generateFiles(hierarchy, paths, basePage, options);
  const read = (name: string) => fs.readFileSync(path.join(root, "playwright", name), "utf8");
  const readVtu = (name: string) => fs.readFileSync(path.join(root, "unit", `${name}.vtu.g.ts`), "utf8");
  const renderedPaths = (spy: MockInstance<Project["createSourceFile"]>) => spy.mock.calls.map(([filePath]) => filePath);

  async function expectSameAsFreshGeneration() {
    const files = fs.readdirSync(root, { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile() && !entry.name.endsWith(".vue"))
      .map(entry => path.join(entry.parentPath, entry.name));
    const before = new Map(files.map(file => [file, fs.readFileSync(file, "utf8")]));
    await generateFiles(hierarchy, paths, basePage, { ...options, renderCache: undefined });
    for (const [file, content] of before) expect(fs.readFileSync(file, "utf8"), file).toBe(content);
  }

  it("skips rendering and writing unchanged POMs, but refreshes a changed child and its parent", async () => {
    component("Editor", '<div><button @click="save">Save</button></div>');
    component("Other", '<div><button @click="cancel">Cancel</button></div>');
    component("EditorPage", "<Editor />", true);
    await emit();
    expect(read("EditorPage.g.ts")).toContain("clickSave(");

    const renders = vi.spyOn(Project.prototype, "createSourceFile");
    const writes = vi.spyOn(fs, "renameSync");
    component("Editor", '<div><button @click="save">New label</button></div>');
    await emit();
    expect(renderedPaths(renders)).not.toContain(path.join(root, "playwright/Editor.g.ts"));
    expect(renderedPaths(renders)).not.toContain(path.join(root, "playwright/EditorPage.g.ts"));
    expect(renderedPaths(renders)).not.toContain(path.join(root, "unit/Editor.vtu.g.ts"));
    expect(writes).not.toHaveBeenCalled();

    renders.mockClear();
    component("Editor", '<div><button @click="submit">Submit</button></div>');
    await emit();
    expect(renderedPaths(renders)).toContain(path.join(root, "playwright/Editor.g.ts"));
    expect(renderedPaths(renders)).toContain(path.join(root, "playwright/EditorPage.g.ts"));
    expect(renderedPaths(renders)).not.toContain(path.join(root, "playwright/Other.g.ts"));
    expect(renderedPaths(renders)).not.toContain(path.join(root, "unit/Other.vtu.g.ts"));
    expect(read("EditorPage.g.ts")).toContain("clickSubmit(");
    expect(read("EditorPage.g.ts")).not.toContain("clickSave(");
    expect(readVtu("Editor")).toContain("clickSubmit(");
    await expectSameAsFreshGeneration();
  });

  it("invalidates writer closures when the selector changes without a method-name change", async () => {
    component("Editor", '<div><button @click="save">Save</button></div>');
    await emit();
    const entry = Array.from(hierarchy.get("Editor")!.dataTestIdSet)[0]!;
    entry.pom!.selector = { ...entry.pom!.selector, formatted: "changed-selector" };
    await emit();
    expect(read("Editor.g.ts")).toContain('"changed-selector"');
    await expectSameAsFreshGeneration();
  });

  it("updates registries, removes deleted outputs and renders a re-added component", async () => {
    component("Editor", '<div><button @click="save">Save</button></div>');
    component("Other", '<div><button @click="cancel">Cancel</button></div>');
    await emit();
    hierarchy.delete("Other");
    paths.delete("Other");
    await emit();
    expect(fs.existsSync(path.join(root, "playwright/Other.g.ts"))).toBe(false);
    expect(fs.existsSync(path.join(root, "unit/Other.vtu.g.ts"))).toBe(false);
    expect(read("index.ts")).not.toContain("Other.g");
    expect(read("fixtures.g.ts")).not.toContain("other: Pom.Other");
    const renders = vi.spyOn(Project.prototype, "createSourceFile");
    component("Other", '<div><button @click="cancel">Cancel</button></div>');
    await emit();
    expect(renderedPaths(renders)).toContain(path.join(root, "playwright/Other.g.ts"));
    expect(read("index.ts")).toContain("Other.g");
    await expectSameAsFreshGeneration();
  });

  it("repairs a deleted or externally edited output even when its render is cached", async () => {
    component("Editor", '<div><button @click="save">Save</button></div>');
    await emit();
    const expected = read("Editor.g.ts");
    fs.unlinkSync(path.join(root, "playwright/Editor.g.ts"));
    await emit();
    expect(read("Editor.g.ts")).toBe(expected);
    fs.writeFileSync(path.join(root, "playwright/Editor.g.ts"), "external edit");
    await emit();
    expect(read("Editor.g.ts")).toBe(expected);
  });

  it("refreshes cached parents when slot outlets change", async () => {
    component("Target", '<div><button @click="save">Save</button><slot /></div>');
    component("Contents", '<div><input v-model="name" /></div>');
    component("Wrapper", '<div><Target><slot name="details" /></Target><button @click="close">Close</button></div>');
    component("Parent", '<Wrapper><template #details="slotProps"><Contents :value="slotProps.value" /></template></Wrapper>', true);
    await emit();
    expect(read("Parent.g.ts")).toContain("readonly Contents: Contents");
    component("Wrapper", '<div><Target><slot name="other" /></Target><button @click="close">Close</button></div>');
    await emit();
    expect(read("Parent.g.ts")).not.toContain("readonly Contents: Contents");
    expect(readVtu("Parent")).not.toContain("readonly Contents: Contents");
    await expectSameAsFreshGeneration();
  });

  it("refreshes route values and flattened custom helper signatures", async () => {
    component("Editor", '<div><button @click="save">Save</button></div>');
    component("EditorPage", "<Editor />", true);
    const helpersDir = path.join(root, "helpers");
    fs.mkdirSync(helpersDir);
    const helperPath = path.join(helpersDir, "EditorHelper.ts");
    fs.writeFileSync(helperPath, "export class EditorHelper { refresh(value: string): void {} }");
    options.customPomDir = helpersDir;
    options.customPomAttachments = [{ className: "EditorHelper", propertyName: "helper", attachWhenUsesComponents: ["Editor"], flatten: true }];
    options.vueRouterFluentChaining = true;
    options.routeMetaByComponent = { EditorPage: { template: "/before", routes: [{ name: "Before", template: "/before", params: [], query: [] }] } };
    await emit();
    expect(read("EditorPage.g.ts")).toContain('"/before"');
    expect(read("EditorPage.g.ts")).toContain("refresh(value: string)");
    options.routeMetaByComponent = { EditorPage: { template: "/after", routes: [{ name: "After", template: "/after", params: [], query: [] }] } };
    fs.writeFileSync(helperPath, "export class EditorHelper { refresh(value: number): void {} }");
    await emit();
    expect(read("EditorPage.g.ts")).toContain('"/after"');
    expect(read("EditorPage.g.ts")).toContain("refresh(value: number)");
    await expectSameAsFreshGeneration();
  });

  it("caches aggregated output and regenerates it after a semantic change", async () => {
    options.typescriptOutputStructure = "aggregated";
    component("Editor", '<div><button @click="save">Save</button></div>');
    await emit();
    const renders = vi.spyOn(Project.prototype, "createSourceFile");
    await emit();
    expect(renderedPaths(renders)).not.toContain(path.join(root, "playwright/page-object-models.g.ts"));
    component("Editor", '<div><button @click="submit">Submit</button></div>');
    await emit();
    expect(renderedPaths(renders)).toContain(path.join(root, "playwright/page-object-models.g.ts"));
    expect(read("page-object-models.g.ts")).toContain("clickSubmit(");
    await expectSameAsFreshGeneration();
  });
});
