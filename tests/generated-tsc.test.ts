// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

import type { IComponentDependencies } from "../utils";
import { generateViewObjectModelMethodContent, generateFiles } from "../class-generation";

function extractClassBlock(content: string, className: string): string {
  const start = content.indexOf(`export class ${className}`);
  if (start < 0) {
    throw new Error(`Class ${className} not found in generated output.`);
  }

  const next = content.indexOf("export class ", start + 1);
  const end = next >= 0 ? next : content.length;
  return content.slice(start, end);
}

function writeFile(filePath: string, content: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function writePlaywrightTypeStub(rootDir: string) {
  // This test typechecks generated output in an isolated temp directory.
  // The generator emits Playwright types (Page/Locator), so provide a minimal
  // module stub for `@playwright/test` to keep the test self-contained.
  writeFile(
    path.join(rootDir, "node_modules", "@playwright", "test", "index.d.ts"),
    [
      "export type Page = any;",
      "export type Locator = any;",
      "export const test: any;",
      "export const expect: any;",
      "",
    ].join("\n"),
  );
}

function runTscNoEmit(files: string[], options?: { cwd?: string }) {
  const require = createRequire(import.meta.url);
  const tscPath = require.resolve("typescript/bin/tsc");

  const args = [
    tscPath,
    "--noEmit",
    "--pretty",
    "false",
    // Keep this focused on syntactic/structural validity of generated output.
    // We provide a small stub BasePage so the generated file can typecheck.
    "--target",
    "ES2022",
    "--module",
    "commonjs",
    "--moduleResolution",
    "node",
    "--skipLibCheck",
    "true",
    ...files,
  ];

  return spawnSync(process.execPath, args, {
    cwd: options?.cwd,
    encoding: "utf8",
  });
}

describe("generated output", () => {
  it("typechecks generated methods (tsc --noEmit)", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vue-pom-generator-"));

    writePlaywrightTypeStub(tempRoot);

    const basePagePath = path.join(tempRoot, "BasePage.ts");
    writeFile(
      basePagePath,
      [
        "export type Fluent<T extends object> = T & PromiseLike<T>;",
        "export class BasePage {",
        "  public page: any;",
        "  public constructor(page?: any, _options?: { testIdAttribute?: string }) {",
        "    this.page = page;",
        "  }",
        "  protected fluent<T extends object>(_factory: () => Promise<T>): Fluent<T> {",
        "    throw new Error('not implemented');",
        "  }",
        "  protected locatorByTestId(_testId: string): any {",
        "    return null as any;",
        "  }",
        "  protected keyedLocators<TKey extends string>(_getLocator: (key: TKey) => any): Record<TKey, any> {",
        "    return {} as any;",
        "  }",
        "  protected selectorForTestId(testId: string): string {",
        "    return `[data-testid=\"${testId}\"]`;",
        "  }",
        "  protected async clickByTestId(_testId: string, _annotationText: string = '', _wait: boolean = true): Promise<void> {}",
        "  protected async fillInputByTestId(_testId: string, _text: string, _annotationText: string = ''): Promise<void> {}",
        "  protected async selectVSelectByTestId(_testId: string, _value: string, _timeOut = 500, _annotationText: string = ''): Promise<void> {}",
        "  protected async animateCursorToElement(_selector: string, _executeClick = true, _delay = 100, _annotationText: string = '', _waitForInstrumentationEvent = true): Promise<void> {}",
        "}",
        "",
      ].join("\n"),
    );

    const componentName = "TestComponent";

    const formattedDataTestId = "TestComponent-${key}-Save-button";
    const methodsContent = generateViewObjectModelMethodContent(
      undefined,
      "Save",
      "button",
      formattedDataTestId,
      { key: "string" },
    );

    const deps: IComponentDependencies = {
      filePath: path.join(tempRoot, `${componentName}.vue`),
      childrenComponentSet: new Set(),
      usedComponentSet: new Set(),
      dataTestIdSet: new Set(),
      methodsContent,
      generatedMethods: new Map(),
      isView: false,
    };

    const componentHierarchyMap = new Map<string, IComponentDependencies>([[componentName, deps]]);
    const vueFilesPathMap = new Map<string, string>();

    const outDir = path.join(tempRoot, "out");

    await generateFiles(componentHierarchyMap, vueFilesPathMap, basePagePath, {
      outDir,
      projectRoot: tempRoot,
    });

    const generatedFilePath = path.join(outDir, "page-object-models.g.ts");
    expect(fs.existsSync(generatedFilePath)).toBe(true);

    const generatedContent = fs.readFileSync(generatedFilePath, "utf8");
    // Keyed locator getters should also expose an indexable property proxy.
    expect(generatedContent).toContain("get SaveButton()");

    const result = runTscNoEmit([generatedFilePath, basePagePath], { cwd: tempRoot });

    if (result.status !== 0) {
      const stdout = (result.stdout || "").toString();
      const stderr = (result.stderr || "").toString();
      throw new Error(`tsc failed (exit ${result.status})\n\nSTDOUT:\n${stdout}\n\nSTDERR:\n${stderr}`);
    }
  });

  it("only emits view passthrough methods when the view has a single child component POM", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vue-pom-generator-"));

    writePlaywrightTypeStub(tempRoot);

    const basePagePath = path.join(tempRoot, "BasePage.ts");
    writeFile(
      basePagePath,
      [
        "export type Fluent<T extends object> = T & PromiseLike<T>;",
        "export class BasePage {",
        "  public page: any;",
        "  public constructor(page?: any, _options?: { testIdAttribute?: string }) {",
        "    this.page = page;",
        "  }",
        "  protected fluent<T extends object>(_factory: () => Promise<T>): Fluent<T> {",
        "    throw new Error('not implemented');",
        "  }",
        "  protected locatorByTestId(_testId: string): any {",
        "    return null as any;",
        "  }",
        "  protected keyedLocators<TKey extends string>(_getLocator: (key: TKey) => any): Record<TKey, any> {",
        "    return {} as any;",
        "  }",
        "  protected selectorForTestId(testId: string): string {",
        "    return `[data-testid=\"${testId}\"]`;",
        "  }",
        "  protected async clickByTestId(_testId: string, _annotationText: string = '', _wait: boolean = true): Promise<void> {}",
        "  protected async fillInputByTestId(_testId: string, _text: string, _annotationText: string = ''): Promise<void> {}",
        "  protected async selectVSelectByTestId(_testId: string, _value: string, _timeOut = 500, _annotationText: string = ''): Promise<void> {}",
        "  protected async animateCursorToElement(_selector: string, _executeClick = true, _delay = 100, _annotationText: string = '', _waitForInstrumentationEvent = true): Promise<void> {}",
        "}",
        "",
      ].join("\n"),
    );

    const viewName = "TestViewPage";
    const childA = "ChildA";
    const childB = "ChildB";

    const childAMethods = generateViewObjectModelMethodContent(
      undefined,
      "OnlyInA",
      "button",
      "ChildA-OnlyInA-button",
      {},
    );

    const childBMethods = generateViewObjectModelMethodContent(
      undefined,
      "SomethingElse",
      "button",
      "ChildB-SomethingElse-button",
      {},
    );

    const depsViewWithTwoChildren: IComponentDependencies = {
      filePath: path.join(tempRoot, `${viewName}.vue`),
      childrenComponentSet: new Set(),
      usedComponentSet: new Set([childA, childB]),
      dataTestIdSet: new Set(),
      methodsContent: "\n",
      generatedMethods: new Map(),
      isView: true,
    };

    const depsChildA: IComponentDependencies = {
      filePath: path.join(tempRoot, `${childA}.vue`),
      childrenComponentSet: new Set(),
      usedComponentSet: new Set(),
      dataTestIdSet: new Set([{ value: "ChildA-OnlyInA-button" }]),
      methodsContent: childAMethods,
      generatedMethods: new Map([["clickOnlyInAButton", { params: "wait: boolean = true", argNames: ["wait"] }]]),
      isView: false,
    };

    const depsChildB: IComponentDependencies = {
      filePath: path.join(tempRoot, `${childB}.vue`),
      childrenComponentSet: new Set(),
      usedComponentSet: new Set(),
      dataTestIdSet: new Set([{ value: "ChildB-SomethingElse-button" }]),
      methodsContent: childBMethods,
      generatedMethods: new Map([["clickSomethingElseButton", { params: "wait: boolean = true", argNames: ["wait"] }]]),
      isView: false,
    };

    const componentHierarchyMapTwo = new Map<string, IComponentDependencies>([
      [viewName, depsViewWithTwoChildren],
      [childA, depsChildA],
      [childB, depsChildB],
    ]);

    const outDirTwo = path.join(tempRoot, "out-two");
    await generateFiles(componentHierarchyMapTwo, new Map(), basePagePath, {
      outDir: outDirTwo,
      projectRoot: tempRoot,
    });

    const aggregatedFileTwo = path.join(outDirTwo, "page-object-models.g.ts");
    expect(fs.existsSync(aggregatedFileTwo)).toBe(true);
    const aggregatedContentTwo = fs.readFileSync(aggregatedFileTwo, "utf8");
    const viewContentTwo = extractClassBlock(aggregatedContentTwo, viewName);

    // With multiple child component POMs, we intentionally do not generate any passthrough methods.
    expect(viewContentTwo).not.toContain("Passthrough methods composed");
    expect(viewContentTwo).not.toContain("async clickOnlyInAButton");

    // Single child component case: passthrough should be emitted.
    const depsViewSingleChild: IComponentDependencies = {
      ...depsViewWithTwoChildren,
      filePath: path.join(tempRoot, `${viewName}Single.vue`),
      usedComponentSet: new Set([childA]),
    };
    const componentHierarchyMapOne = new Map<string, IComponentDependencies>([
      ["TestViewPageSingle", depsViewSingleChild],
      [childA, depsChildA],
    ]);

    const outDirOne = path.join(tempRoot, "out-one");
    await generateFiles(componentHierarchyMapOne, new Map(), basePagePath, {
      outDir: outDirOne,
      projectRoot: tempRoot,
    });

    const aggregatedFileOne = path.join(outDirOne, "page-object-models.g.ts");
    expect(fs.existsSync(aggregatedFileOne)).toBe(true);
    const aggregatedContentOne = fs.readFileSync(aggregatedFileOne, "utf8");
    const viewContentOne = extractClassBlock(aggregatedContentOne, "TestViewPageSingle");
    expect(viewContentOne).toContain("Passthrough methods composed");
    expect(viewContentOne).toContain("async clickOnlyInAButton");
  });
});
