// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

import type { IComponentDependencies, IDataTestId } from "../utils";
import { generateFiles } from "../class-generation";

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
      "export const test: { extend<T>(_fixtures: any): any };",
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
        "  protected async clickWithinTestIdByLabel(_rootTestId: string, _label: string, _annotationText: string = '', _wait: boolean = true, _options?: { exact?: boolean }): Promise<void> {}",
        "  protected async fillInputByTestId(_testId: string, _text: string, _annotationText: string = ''): Promise<void> {}",
        "  protected async selectVSelectByTestId(_testId: string, _value: string, _timeOut = 500, _annotationText: string = ''): Promise<void> {}",
        "  protected async animateCursorToElement(_selector: string, _executeClick = true, _delay = 100, _annotationText: string = '', _waitForInstrumentationEvent = true): Promise<void> {}",
        "}",
        "",
      ].join("\n"),
    );

    // The generator now also inlines Pointer.ts. Provide a minimal stub next to BasePage.ts.
    const pointerPath = path.join(tempRoot, "Pointer.ts");
    writeFile(
      pointerPath,
      [
        "export type PlaywrightAnimationOptions = any;",
        "export function setPlaywrightAnimationOptions(_animation: PlaywrightAnimationOptions): void {}",
        "export class Pointer {",
        "  public constructor(_page: any, _testIdAttribute: string) {}",
        "}",
        "",
      ].join("\n"),
    );

    const componentName = "TestComponent";

    const formattedDataTestId = "TestComponent-${key}-Save-button";
    const dataTestIdEntry: IDataTestId = {
      value: formattedDataTestId,
      pom: {
        nativeRole: "button",
        methodName: "SaveButton",
        formattedDataTestId,
        params: { key: "string" },
      },
    };

    const deps: IComponentDependencies = {
      filePath: path.join(tempRoot, `${componentName}.vue`),
      childrenComponentSet: new Set(),
      usedComponentSet: new Set(),
      dataTestIdSet: new Set([dataTestIdEntry]),
      pomExtraMethods: [
        {
          kind: "click",
          name: "selectDatabaseTypeCloud",
          selector: {
            kind: "withinTestIdByLabel",
            rootFormattedDataTestId: "TestComponent-databaseType-radio",
            formattedLabel: "Cloud",
            exact: true,
          },
          params: { annotationText: "string = \"\"" },
        },
      ],
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

  it("typechecks generated fixtures that prefer matching override classes", async () => {
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
        "}",
        "",
      ].join("\n"),
    );
    writeFile(
      path.join(tempRoot, "Pointer.ts"),
      [
        "export type PlaywrightAnimationOptions = any;",
        "export function setPlaywrightAnimationOptions(_animation: PlaywrightAnimationOptions): void {}",
        "export class Pointer {",
        "  public constructor(_page: any, _testIdAttribute: string) {}",
        "}",
        "",
      ].join("\n"),
    );

    writeFile(
      path.join(tempRoot, "tests", "playwright", "pom", "overrides", "PersonListPage.ts"),
      [
        "import { PersonListPage as GeneratedPersonListPage } from \"../../__generated__/page-object-models.g\";",
        "export class PersonListPage extends GeneratedPersonListPage {}",
        "",
      ].join("\n"),
    );

    const deps: IComponentDependencies = {
      filePath: path.join(tempRoot, "src", "views", "PersonListPage.vue"),
      childrenComponentSet: new Set(),
      usedComponentSet: new Set(),
      dataTestIdSet: new Set(),
      generatedMethods: new Map(),
      isView: true,
    };

    const componentHierarchyMap = new Map<string, IComponentDependencies>([["PersonListPage", deps]]);
    const vueFilesPathMap = new Map<string, string>();
    const outDir = path.join(tempRoot, "tests", "playwright", "__generated__");

    await generateFiles(componentHierarchyMap, vueFilesPathMap, basePagePath, {
      outDir,
      projectRoot: tempRoot,
      generateFixtures: true,
    });

    const fixtureFile = path.join(outDir, "fixtures.g.ts");
    const fixtureContent = fs.readFileSync(fixtureFile, "utf8");
    expect(fixtureContent).toContain("import { PersonListPage as PersonListPageOverride }");
    expect(fixtureContent).toContain("personListPage: PersonListPageOverride");

    const result = runTscNoEmit([fixtureFile, basePagePath], { cwd: tempRoot });

    if (result.status !== 0) {
      const stdout = (result.stdout || "").toString();
      const stderr = (result.stderr || "").toString();
      throw new Error(`tsc failed (exit ${result.status})\n\nSTDOUT:\n${stdout}\n\nSTDERR:\n${stderr}`);
    }
  });

  it("fails by default when custom POM import collides with generated class name", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vue-pom-generator-"));

    writePlaywrightTypeStub(tempRoot);

    const basePagePath = path.join(tempRoot, "BasePage.ts");
    writeFile(basePagePath, "export class BasePage { constructor(public page?: any) {} }");
    writeFile(
      path.join(tempRoot, "Pointer.ts"),
      "export type PlaywrightAnimationOptions = any; export function setPlaywrightAnimationOptions(_: PlaywrightAnimationOptions): void {} export class Pointer { constructor(_: any, __: string) {} }",
    );

    writeFile(
      path.join(tempRoot, "tests", "playwright", "pom", "custom", "PersonListPage.ts"),
      "export class PersonListPage { constructor(_: any, __?: any) {} }",
    );

    const deps: IComponentDependencies = {
      filePath: path.join(tempRoot, "src", "views", "PersonListPage.vue"),
      childrenComponentSet: new Set(),
      usedComponentSet: new Set(),
      dataTestIdSet: new Set(),
      generatedMethods: new Map(),
      isView: true,
    };

    const componentHierarchyMap = new Map<string, IComponentDependencies>([["PersonListPage", deps]]);
    const vueFilesPathMap = new Map<string, string>();

    await expect(generateFiles(componentHierarchyMap, vueFilesPathMap, basePagePath, {
      outDir: path.join(tempRoot, "out"),
      projectRoot: tempRoot,
      customPomDir: "tests/playwright/pom/custom",
    })).rejects.toThrow("Custom POM import name collision detected");
  });

  it("can auto-alias colliding custom POM imports when configured", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vue-pom-generator-"));

    writePlaywrightTypeStub(tempRoot);

    const basePagePath = path.join(tempRoot, "BasePage.ts");
    writeFile(
      basePagePath,
      [
        "export type Fluent<T extends object> = T & PromiseLike<T>;",
        "export class BasePage {",
        "  constructor(public page?: any, _options?: { testIdAttribute?: string }) {}",
        "}",
      ].join("\n"),
    );
    writeFile(
      path.join(tempRoot, "Pointer.ts"),
      "export type PlaywrightAnimationOptions = any; export function setPlaywrightAnimationOptions(_: PlaywrightAnimationOptions): void {} export class Pointer { constructor(_: any, __: string) {} }",
    );

    writeFile(
      path.join(tempRoot, "tests", "playwright", "pom", "custom", "PersonListPage.ts"),
      "export class PersonListPage { constructor(_: any, __?: any) {} }",
    );

    const deps: IComponentDependencies = {
      filePath: path.join(tempRoot, "src", "views", "PersonListPage.vue"),
      childrenComponentSet: new Set(),
      usedComponentSet: new Set(["Page"]),
      dataTestIdSet: new Set(),
      generatedMethods: new Map(),
      isView: true,
    };

    const componentHierarchyMap = new Map<string, IComponentDependencies>([["PersonListPage", deps]]);
    const vueFilesPathMap = new Map<string, string>();
    const outDir = path.join(tempRoot, "out");

    await generateFiles(componentHierarchyMap, vueFilesPathMap, basePagePath, {
      outDir,
      projectRoot: tempRoot,
      customPomDir: "tests/playwright/pom/custom",
      customPomImportNameCollisionBehavior: "alias",
      customPomAttachments: [{
        className: "PersonListPage",
        propertyName: "personListHelper",
        attachWhenUsesComponents: ["Page"],
      }],
    });

    const generatedFile = path.join(outDir, "page-object-models.g.ts");
    const generatedContent = fs.readFileSync(generatedFile, "utf8");

    expect(generatedContent).toContain("import { PersonListPage as PersonListPageCustom }");
    expect(generatedContent).toContain("personListHelper: PersonListPageCustom;");
    expect(generatedContent).toContain("this.personListHelper = new PersonListPageCustom(page, this);");
  });

  it("flattens configured custom attachment methods onto generated classes", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vue-pom-generator-"));

    writePlaywrightTypeStub(tempRoot);

    const basePagePath = path.join(tempRoot, "BasePage.ts");
    writeFile(
      basePagePath,
      [
        "export type Fluent<T extends object> = T & PromiseLike<T>;",
        "export class BasePage {",
        "  constructor(public page?: any, _options?: { testIdAttribute?: string }) {}",
        "}",
      ].join("\n"),
    );
    writeFile(
      path.join(tempRoot, "Pointer.ts"),
      "export type PlaywrightAnimationOptions = any; export function setPlaywrightAnimationOptions(_: PlaywrightAnimationOptions): void {} export class Pointer { constructor(_: any, __: string) {} }",
    );
    writeFile(
      path.join(tempRoot, "tests", "playwright", "pom", "custom", "Grid.ts"),
      [
        "export class Grid {",
        "  constructor(_page: any, _owner: any) {}",
        "  Search(text: string, options?: { timeoutMs?: number }) {",
        "    return { text, options };",
        "  }",
        "  searchHighlight(text: string) {",
        "    return text;",
        "  }",
        "}",
      ].join("\n"),
    );

    const deps: IComponentDependencies = {
      filePath: path.join(tempRoot, "src", "components", "UsersTable.vue"),
      childrenComponentSet: new Set(["ImmyDxDataGrid"]),
      usedComponentSet: new Set(["ImmyDxDataGrid"]),
      dataTestIdSet: new Set([
        {
          value: "UsersTable-Refresh-button",
        },
      ]),
      generatedMethods: new Map(),
      isView: false,
    };

    const componentHierarchyMap = new Map<string, IComponentDependencies>([["UsersTable", deps]]);
    const vueFilesPathMap = new Map<string, string>();
    const outDir = path.join(tempRoot, "out");

    await generateFiles(componentHierarchyMap, vueFilesPathMap, basePagePath, {
      outDir,
      projectRoot: tempRoot,
      customPomDir: "tests/playwright/pom/custom",
      customPomAttachments: [{
        className: "Grid",
        propertyName: "grid",
        attachWhenUsesComponents: ["ImmyDxDataGrid"],
        attachTo: "both",
        flatten: true,
      }],
    });

    const generatedFile = path.join(outDir, "page-object-models.g.ts");
    const generatedContent = fs.readFileSync(generatedFile, "utf8");
    const classBlock = extractClassBlock(generatedContent, "UsersTable");

    expect(classBlock).toContain("grid: Grid;");
    expect(classBlock).toContain("Search(text: string, options?: { timeoutMs?: number }) {");
    expect(classBlock).toContain("return this.grid.Search(text, options);");
    expect(classBlock).toContain("searchHighlight(text: string) {");
    expect(classBlock).toContain("return this.grid.searchHighlight(text);");

    const result = runTscNoEmit([generatedFile, basePagePath], { cwd: tempRoot });

    if (result.status !== 0) {
      const stdout = (result.stdout || "").toString();
      const stderr = (result.stderr || "").toString();
      throw new Error(`tsc failed (exit ${result.status})\n\nSTDOUT:\n${stdout}\n\nSTDERR:\n${stderr}`);
    }
  });

  it("skips missing custom helper attachments and widget instances when no helper files exist", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vue-pom-generator-"));

    writePlaywrightTypeStub(tempRoot);

    const basePagePath = path.join(tempRoot, "BasePage.ts");
    writeFile(
      basePagePath,
      [
        "export type Fluent<T extends object> = T & PromiseLike<T>;",
        "export class BasePage {",
        "  constructor(public page?: any, _options?: { testIdAttribute?: string }) {}",
        "}",
      ].join("\n"),
    );
    writeFile(
      path.join(tempRoot, "Pointer.ts"),
      "export type PlaywrightAnimationOptions = any; export function setPlaywrightAnimationOptions(_: PlaywrightAnimationOptions): void {} export class Pointer { constructor(_: any, __: string) {} }",
    );

    const deps: IComponentDependencies = {
      filePath: path.join(tempRoot, "src", "views", "UsersView.vue"),
      childrenComponentSet: new Set(),
      usedComponentSet: new Set(["Page", "ImmyDxDataGrid"]),
      dataTestIdSet: new Set([
        {
          value: "UsersView-EnableSessionEmails-toggle",
        },
      ]),
      generatedMethods: new Map(),
      isView: true,
    };

    const componentHierarchyMap = new Map<string, IComponentDependencies>([["UsersView", deps]]);
    const vueFilesPathMap = new Map<string, string>();
    const outDir = path.join(tempRoot, "out");

    await generateFiles(componentHierarchyMap, vueFilesPathMap, basePagePath, {
      outDir,
      projectRoot: tempRoot,
      customPomDir: "tests/playwright/pom/custom",
      customPomAttachments: [
        {
          className: "Grid",
          propertyName: "grid",
          attachWhenUsesComponents: ["ImmyDxDataGrid"],
          attachTo: "both",
          flatten: true,
        },
        {
          className: "ConfirmationModal",
          propertyName: "confirmationModal",
          attachWhenUsesComponents: ["Page"],
          flatten: true,
        },
      ],
    });

    const generatedFile = path.join(outDir, "page-object-models.g.ts");
    const generatedContent = fs.readFileSync(generatedFile, "utf8");

    expect(generatedContent).not.toContain("ToggleWidget");
    expect(generatedContent).not.toContain("CheckboxWidget");
    expect(generatedContent).not.toContain("new Grid(");
    expect(generatedContent).not.toContain("new ConfirmationModal(");
    expect(generatedContent).not.toContain("return this.grid.");
    expect(generatedContent).not.toContain("return this.confirmationModal.");

    const result = runTscNoEmit([generatedFile, basePagePath], { cwd: tempRoot });

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

    // The generator now also inlines Pointer.ts. Provide a minimal stub next to BasePage.ts.
    const pointerPath = path.join(tempRoot, "Pointer.ts");
    writeFile(
      pointerPath,
      [
        "export type PlaywrightAnimationOptions = any;",
        "export function setPlaywrightAnimationOptions(_animation: PlaywrightAnimationOptions): void {}",
        "export class Pointer {",
        "  public constructor(_page: any, _testIdAttribute: string) {}",
        "}",
        "",
      ].join("\n"),
    );

    const viewName = "TestViewPage";
    const childA = "ChildA";
    const childB = "ChildB";

    const childAEntry: IDataTestId = {
      value: "ChildA-OnlyInA-button",
      pom: {
        nativeRole: "button",
        methodName: "OnlyInAButton",
        formattedDataTestId: "ChildA-OnlyInA-button",
        params: {},
      },
    };

    const childBEntry: IDataTestId = {
      value: "ChildB-SomethingElse-button",
      pom: {
        nativeRole: "button",
        methodName: "SomethingElseButton",
        formattedDataTestId: "ChildB-SomethingElse-button",
        params: {},
      },
    };

    const depsViewWithTwoChildren: IComponentDependencies = {
      filePath: path.join(tempRoot, `${viewName}.vue`),
      childrenComponentSet: new Set(),
      usedComponentSet: new Set([childA, childB]),
      dataTestIdSet: new Set(),
      generatedMethods: new Map(),
      isView: true,
    };

    const depsChildA: IComponentDependencies = {
      filePath: path.join(tempRoot, `${childA}.vue`),
      childrenComponentSet: new Set(),
      usedComponentSet: new Set(),
      dataTestIdSet: new Set([childAEntry]),
      generatedMethods: new Map([["clickOnlyInAButton", { params: "wait: boolean = true", argNames: ["wait"] }]]),
      isView: false,
    };

    const depsChildB: IComponentDependencies = {
      filePath: path.join(tempRoot, `${childB}.vue`),
      childrenComponentSet: new Set(),
      usedComponentSet: new Set(),
      dataTestIdSet: new Set([childBEntry]),
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
