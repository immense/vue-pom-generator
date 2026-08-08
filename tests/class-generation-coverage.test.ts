// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { IComponentDependencies, IDataTestId } from "../utils";
import { generateFiles } from "../class-generation";
import { createPomMethodSignature, createPomParameters } from "../pom-params";
import { createPomStringPattern } from "../pom-patterns";
import { renderTypeScriptLines } from "../typescript-codegen";

function writeFile(filePath: string, content: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const normalizedContent = filePath.endsWith(".ts") || filePath.endsWith(".tsx") || filePath.endsWith(".mts") || filePath.endsWith(".cts") || filePath.endsWith(".d.ts")
    ? renderTypeScriptLines(content.replace(/\r\n/g, "\n").split("\n"))
    : content;
  fs.writeFileSync(filePath, normalizedContent, "utf8");
}

function readFile(filePath: string) {
  return fs.readFileSync(filePath, "utf8");
}

function makeTempRoot(prefix: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeMinimalBasePage(filePath: string) {
  // The aggregated generator inlines this module. Keep it intentionally tiny.
  writeFile(
    filePath,
    [
      "export type Fluent<T extends object> = T & PromiseLike<T>;",
      "export class BasePage {",
      "  public page: any;",
      "  public constructor(page?: any, _options?: { testIdAttribute?: string }) {",
      "    this.page = page;",
      "  }",
      "  protected describeLocator<T>(_locator: T, _description?: string): T {",
      "    return _locator;",
      "  }",
      "}",
      "",
    ].join("\n"),
  );

	// The generator now also inlines pointer.ts. Provide a minimal stub next to base-page.ts.
	const pointerPath = path.join(path.dirname(filePath), "pointer.ts");
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
}

function makeDeps(options: Partial<IComponentDependencies> & { filePath: string }): IComponentDependencies {
  return {
    filePath: options.filePath,
    childrenComponentSet: options.childrenComponentSet ?? new Set(),
    usedComponentSet: options.usedComponentSet ?? new Set(),
    dataTestIdSet: options.dataTestIdSet ?? new Set(),
    methodsContent: options.methodsContent ?? "\n",
    generatedMethods: options.generatedMethods,
    isView: options.isView,
  };
}

describe("class-generation coverage", () => {
  it("generates Playwright fixture registry (default, dir, and explicit file path)", async () => {
    const tempRoot = makeTempRoot("vue-pom-fixtures-");

    try {
      const basePagePath = path.join(tempRoot, "base-page.ts");
      writeMinimalBasePage(basePagePath);

      const componentHierarchyMap = new Map<string, IComponentDependencies>([
        [
          "UsersPage",
          makeDeps({
            filePath: path.join(tempRoot, "src", "views", "UsersPage.vue"),
            isView: true,
          }),
        ],
        [
          "ThingWidget",
          makeDeps({
            filePath: path.join(tempRoot, "src", "components", "ThingWidget.vue"),
            isView: false,
          }),
        ],
        [
          "WrapperButton",
          makeDeps({
            filePath: path.join(tempRoot, "src", "components", "WrapperButton.vue"),
            isView: false,
            dataTestIdSet: new Set<IDataTestId>([{
              selectorValue: createPomStringPattern("WrapperButton-Click-button", "static", []),
              pom: {
                nativeRole: "button",
                methodName: "WrapperButton",
                selector: createPomStringPattern("WrapperButton-Click-button", "static", []),
                parameters: [],
                generatedActionName: "clickWrapperButton",
                generatedPropertyName: "WrapperButton",
              },
            }]),
          }),
        ],
        // Should be filtered out because fixture name would be "page" (reserved by Playwright)
        [
          "Page",
          makeDeps({
            filePath: path.join(tempRoot, "src", "components", "Page.vue"),
            isView: false,
          }),
        ],
      ]);

      const outDir = path.join(tempRoot, "pom");
      writeFile(
        path.join(tempRoot, "tests", "playwright", "pom", "overrides", "UsersPage.ts"),
        [
          "export class UsersPage {",
          "  public constructor(_page?: any) {}",
          "}",
          "",
        ].join("\n"),
      );
      writeFile(
        path.join(outDir, ".gitattributes"),
        [
          "# existing user-owned entry",
          "README.md linguist-documentation",
          "",
        ].join("\n"),
      );

      // 1) default location: <outDir>/fixtures.g.ts
      await generateFiles(componentHierarchyMap, new Map(), basePagePath, {
        outDir,
        projectRoot: tempRoot,
        generateFixtures: true,
      });

      const defaultFixturePath = path.join(outDir, "fixtures.g.ts");
      expect(fs.existsSync(defaultFixturePath)).toBe(true);

      const defaultFixtureContent = readFile(defaultFixturePath);
      expect(defaultFixtureContent).toContain("Generated Playwright fixtures");
      expect(defaultFixtureContent).toContain("import { UsersPage as UsersPageOverride } from \"../tests/playwright/pom/overrides/UsersPage\";");
      expect(defaultFixtureContent).toContain("usersPage: UsersPageOverride");
      expect(defaultFixtureContent).toContain("thingWidget: Pom.ThingWidget");
      expect(defaultFixtureContent).not.toContain("wrapperButton: Pom.WrapperButton");
      // Reserved fixture name should not appear as a generated component fixture.
      expect(defaultFixtureContent).not.toContain("page: Pom.Page");

      const defaultGitAttributesPath = path.join(outDir, ".gitattributes");
      expect(fs.existsSync(defaultGitAttributesPath)).toBe(true);
      const defaultGitAttributesContent = readFile(defaultGitAttributesPath);
      expect(defaultGitAttributesContent).toContain("README.md linguist-documentation");
      expect(defaultGitAttributesContent).toContain("page-object-models.g.ts linguist-generated");
      expect(defaultGitAttributesContent).toContain("index.ts linguist-generated");
      expect(defaultGitAttributesContent).toContain("fixtures.g.ts linguist-generated");

      const runtimeGitAttributesPath = path.join(outDir, "_pom-runtime", ".gitattributes");
      expect(fs.existsSync(runtimeGitAttributesPath)).toBe(true);
      const runtimeGitAttributesContent = readFile(runtimeGitAttributesPath);
      expect(runtimeGitAttributesContent).toContain("click-instrumentation.ts linguist-generated");

      const runtimeClassGenGitAttributesPath = path.join(outDir, "_pom-runtime", "class-generation", ".gitattributes");
      expect(fs.existsSync(runtimeClassGenGitAttributesPath)).toBe(true);
      const runtimeClassGenGitAttributesContent = readFile(runtimeClassGenGitAttributesPath);
      expect(runtimeClassGenGitAttributesContent).toContain("base-page.ts linguist-generated");
      expect(runtimeClassGenGitAttributesContent).toContain("callout.ts linguist-generated");
      expect(runtimeClassGenGitAttributesContent).toContain("floating-ui-callout.ts linguist-generated");
      expect(runtimeClassGenGitAttributesContent).toContain("floating-ui.ts linguist-generated");
      expect(runtimeClassGenGitAttributesContent).toContain("pointer.ts linguist-generated");
      expect(runtimeClassGenGitAttributesContent).toContain("playwright-types.ts linguist-generated");
      expect(readFile(fileURLToPath(new URL("../class-generation/base-page.ts", import.meta.url)))).toContain("export class BasePage");
      const runtimeFloatingUiContent = readFile(path.join(outDir, "_pom-runtime", "class-generation", "floating-ui.ts"));
      expect(runtimeFloatingUiContent).toContain("Portions of this file are derived from Floating UI.");
      expect(runtimeFloatingUiContent).toContain("SPDX-License-Identifier: MIT");

      // 2) explicit file path
      await generateFiles(componentHierarchyMap, new Map(), basePagePath, {
        outDir,
        projectRoot: tempRoot,
        generateFixtures: "tests/playwright/fixture/CustomFixtures.ts",
      });

      const explicitFixturePath = path.join(tempRoot, "tests", "playwright", "fixture", "CustomFixtures.ts");
      expect(fs.existsSync(explicitFixturePath)).toBe(true);
      const explicitFixtureContent = readFile(explicitFixturePath);
      expect(explicitFixtureContent).toContain("import { UsersPage as UsersPageOverride } from \"../pom/overrides/UsersPage\";");
      expect(explicitFixtureContent).toContain("usersPage: UsersPageOverride");
      const explicitGitAttributesPath = path.join(tempRoot, "tests", "playwright", "fixture", ".gitattributes");
      expect(fs.existsSync(explicitGitAttributesPath)).toBe(true);
      expect(readFile(explicitGitAttributesPath)).toContain("CustomFixtures.ts linguist-generated");

      // 3) explicit outDir via object
      await generateFiles(componentHierarchyMap, new Map(), basePagePath, {
        outDir,
        projectRoot: tempRoot,
        generateFixtures: { outDir: "tests/playwright/fixture-alt" },
      });

      const altFixturePath = path.join(tempRoot, "tests", "playwright", "fixture-alt", "fixtures.g.ts");
      expect(fs.existsSync(altFixturePath)).toBe(true);
      const altGitAttributesPath = path.join(tempRoot, "tests", "playwright", "fixture-alt", ".gitattributes");
      expect(fs.existsSync(altGitAttributesPath)).toBe(true);
      expect(readFile(altGitAttributesPath)).toContain("fixtures.g.ts linguist-generated");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("skips managed .gitattributes when outputs live under __generated__", async () => {
    const tempRoot = makeTempRoot("vue-pom-generated-path-");

    try {
      const basePagePath = path.join(tempRoot, "base-page.ts");
      writeMinimalBasePage(basePagePath);

      const componentHierarchyMap = new Map<string, IComponentDependencies>([
        [
          "UsersPage",
          makeDeps({
            filePath: path.join(tempRoot, "src", "views", "UsersPage.vue"),
            isView: true,
          }),
        ],
      ]);

      const outDir = path.join(tempRoot, "tests", "playwright", "__generated__");
      await generateFiles(componentHierarchyMap, new Map(), basePagePath, {
        outDir,
        projectRoot: tempRoot,
        generateFixtures: true,
      });

      expect(fs.existsSync(path.join(outDir, "page-object-models.g.ts"))).toBe(true);
      expect(fs.existsSync(path.join(outDir, "fixtures.g.ts"))).toBe(true);
      expect(fs.existsSync(path.join(outDir, ".gitattributes"))).toBe(false);
      expect(fs.existsSync(path.join(outDir, "_pom-runtime", ".gitattributes"))).toBe(false);
      expect(fs.existsSync(path.join(outDir, "_pom-runtime", "class-generation", ".gitattributes"))).toBe(false);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("emits stub POM classes for navigation targets, composing child POMs by scanning the SFC template", async () => {
    const tempRoot = makeTempRoot("vue-pom-stubs-");

    try {
      const basePagePath = path.join(tempRoot, "base-page.ts");
      writeMinimalBasePage(basePagePath);

      // Create a referenced target view that will NOT be in componentHierarchyMap.
      // The generator should emit a stub class for it.
      writeFile(
        path.join(tempRoot, "src", "views", "NewTenantPage.vue"),
        [
          "<template>",
          "  <tenant-details-edit-form />",
          "</template>",
          "",
        ].join("\n"),
      );

      const dt: IDataTestId = {
        selectorValue: createPomStringPattern("TenantListPage-NewTenant-routerlink", "static", []),
        targetPageObjectModelClass: "NewTenantPage",
      };

      const depsTenantListPage = makeDeps({
        filePath: path.join(tempRoot, "src", "views", "TenantListPage.vue"),
        isView: true,
        dataTestIdSet: new Set([dt]),
      });

      const depsForm = makeDeps({
        filePath: path.join(tempRoot, "src", "components", "TenantDetailsEditForm.vue"),
        isView: false,
        dataTestIdSet: new Set([{ selectorValue: createPomStringPattern("TenantDetailsEditForm-Name-input", "static", []) }]),
        generatedMethods: new Map([
          ["typeTenantName", createPomMethodSignature(createPomParameters(["name", "string"]))],
        ]),
      });

      const componentHierarchyMap = new Map<string, IComponentDependencies>([
        ["TenantListPage", depsTenantListPage],
        ["TenantDetailsEditForm", depsForm],
      ]);

      const outDir = path.join(tempRoot, "pom");
      await generateFiles(componentHierarchyMap, new Map(), basePagePath, {
        outDir,
        projectRoot: tempRoot,
      });

      const aggregatedFile = path.join(outDir, "page-object-models.g.ts");
      expect(fs.existsSync(aggregatedFile)).toBe(true);

      const content = readFile(aggregatedFile);

      // Stub class emitted.
      expect(content).toContain("export class NewTenantPage extends BasePage");
      // Composed child property from template scan.
      expect(content).toContain("TenantDetailsEditForm: TenantDetailsEditForm;");
      // And passthrough method delegation when unambiguous.
      expect(content).toContain("async typeTenantName(name: string)");
      expect(content).toContain("return await this.TenantDetailsEditForm.typeTenantName(name)");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("emits split TypeScript POM files with a stable barrel and stub targets", async () => {
    const tempRoot = makeTempRoot("vue-pom-split-");

    try {
      const basePagePath = path.join(tempRoot, "base-page.ts");
      writeMinimalBasePage(basePagePath);

      writeFile(
        path.join(tempRoot, "src", "views", "NewTenantPage.vue"),
        [
          "<template>",
          "  <tenant-details-edit-form />",
          "</template>",
          "",
        ].join("\n"),
      );

      const navigationEntry: IDataTestId = {
        selectorValue: createPomStringPattern("TenantListPage-NewTenant-routerlink", "static", []),
        targetPageObjectModelClass: "NewTenantPage",
      };

      const depsTenantListPage = makeDeps({
        filePath: path.join(tempRoot, "src", "views", "TenantListPage.vue"),
        isView: true,
        usedComponentSet: new Set(["TenantDetailsEditForm"]),
        dataTestIdSet: new Set([navigationEntry]),
      });

      const depsForm = makeDeps({
        filePath: path.join(tempRoot, "src", "components", "TenantDetailsEditForm.vue"),
        isView: false,
        dataTestIdSet: new Set([{ selectorValue: createPomStringPattern("TenantDetailsEditForm-Name-input", "static", []) }]),
        generatedMethods: new Map([
          ["typeTenantName", createPomMethodSignature(createPomParameters(["name", "string"]))],
        ]),
      });

      const componentHierarchyMap = new Map<string, IComponentDependencies>([
        ["TenantListPage", depsTenantListPage],
        ["TenantDetailsEditForm", depsForm],
      ]);

      const outDir = path.join(tempRoot, "pom");
      await generateFiles(componentHierarchyMap, new Map(), basePagePath, {
        outDir,
        projectRoot: tempRoot,
        typescriptOutputStructure: "split",
      });

      expect(fs.existsSync(path.join(outDir, "page-object-models.g.ts"))).toBe(false);

      const indexContent = readFile(path.join(outDir, "index.ts"));
      const runtimeBarrelExports = indexContent
        .split("\n")
        .filter(line => line.startsWith('export * from "./_pom-runtime/'))
        .sort((a, b) => a.localeCompare(b));
      const expectedRuntimeBarrelExports = [
        ...fs.readdirSync(path.join(outDir, "_pom-runtime"))
          .filter(file => file.endsWith(".ts"))
          .sort((a, b) => a.localeCompare(b))
          .map(file => `export * from "./_pom-runtime/${path.basename(file, ".ts")}";`),
        ...fs.readdirSync(path.join(outDir, "_pom-runtime", "class-generation"))
          .filter(file => file.endsWith(".ts"))
          .sort((a, b) => a.localeCompare(b))
          .map(file => `export * from "./_pom-runtime/class-generation/${path.basename(file, ".ts")}";`),
      ].sort((a, b) => a.localeCompare(b));
      expect(indexContent).toContain('export * from "./TenantDetailsEditForm.g";');
      expect(indexContent).toContain('export * from "./TenantListPage.g";');
      expect(indexContent).toContain('export * from "./NewTenantPage.g";');
      expect(runtimeBarrelExports).toEqual(expectedRuntimeBarrelExports);

      const tenantListPageContent = readFile(path.join(outDir, "TenantListPage.g.ts"));
      expect(tenantListPageContent).toContain('import { NewTenantPage }');
      expect(tenantListPageContent).toContain('import { TenantDetailsEditForm }');

      const newTenantPageContent = readFile(path.join(outDir, "NewTenantPage.g.ts"));
      expect(newTenantPageContent).toContain("export class NewTenantPage extends BasePage");
      expect(newTenantPageContent).toContain("TenantDetailsEditForm: TenantDetailsEditForm;");
      expect(newTenantPageContent).toContain("async typeTenantName(name: string)");

      const gitAttributesContent = readFile(path.join(outDir, ".gitattributes"));
      expect(gitAttributesContent).toContain("TenantDetailsEditForm.g.ts linguist-generated");
      expect(gitAttributesContent).toContain("TenantListPage.g.ts linguist-generated");
      expect(gitAttributesContent).toContain("NewTenantPage.g.ts linguist-generated");
      expect(gitAttributesContent).toContain("index.ts linguist-generated");
    }
    finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("attaches nested component POMs to views when the template tag omits the folder-prefixed class name", async () => {
    const tempRoot = makeTempRoot("vue-pom-nested-attach-");

    try {
      const basePagePath = path.join(tempRoot, "base-page.ts");
      writeMinimalBasePage(basePagePath);

      const depsDeploymentDetailsPage = makeDeps({
        filePath: path.join(tempRoot, "src", "views", "DeploymentDetailsPage.vue"),
        isView: true,
        usedComponentSet: new Set(["MaintenanceItemConfiguration"]),
      });

      const depsNestedComponent = makeDeps({
        filePath: path.join(tempRoot, "src", "components", "MaintenanceItems", "MaintenanceItemConfiguration.vue"),
        isView: false,
        dataTestIdSet: new Set([{
          selectorValue: createPomStringPattern("MaintenanceItemsMaintenanceItemConfiguration-Save-button", "static", []),
          pom: {
            nativeRole: "button",
            methodName: "Save",
            selector: createPomStringPattern("MaintenanceItemsMaintenanceItemConfiguration-Save-button", "static", []),
            parameters: [],
          },
        }]),
        generatedMethods: new Map([
          ["clickSave", createPomMethodSignature(createPomParameters(["wait", "boolean = true"], ["annotationText", 'string = ""']))],
        ]),
      });

      const componentHierarchyMap = new Map<string, IComponentDependencies>([
        ["DeploymentDetailsPage", depsDeploymentDetailsPage],
        ["MaintenanceItemsMaintenanceItemConfiguration", depsNestedComponent],
      ]);

      const outDir = path.join(tempRoot, "pom");
      await generateFiles(componentHierarchyMap, new Map(), basePagePath, {
        outDir,
        projectRoot: tempRoot,
        typescriptOutputStructure: "split",
      });

      const pageContent = readFile(path.join(outDir, "DeploymentDetailsPage.g.ts"));
      expect(pageContent).toContain('import { MaintenanceItemsMaintenanceItemConfiguration }');
      expect(pageContent).toContain('MaintenanceItemsMaintenanceItemConfiguration: MaintenanceItemsMaintenanceItemConfiguration;');
      expect(pageContent).toContain('this.MaintenanceItemsMaintenanceItemConfiguration = new MaintenanceItemsMaintenanceItemConfiguration(page);');
      expect(pageContent).toContain('async clickSave(');
      expect(pageContent).toContain('return await this.MaintenanceItemsMaintenanceItemConfiguration.clickSave(wait, annotationText)');
    }
    finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("attaches nested component POMs to component POMs in split output", async () => {
    const tempRoot = makeTempRoot("vue-pom-component-child-attach-");

    try {
      const basePagePath = path.join(tempRoot, "base-page.ts");
      writeMinimalBasePage(basePagePath);

      const depsParentComponent = makeDeps({
        filePath: path.join(tempRoot, "src", "components", "MaintenanceItems", "MaintenanceItemConfiguration.vue"),
        isView: false,
        childrenComponentSet: new Set(["MaintenanceItemsMaintenanceItemSelector"]),
      });

      const depsChildComponent = makeDeps({
        filePath: path.join(tempRoot, "src", "components", "MaintenanceItems", "MaintenanceItemSelector.vue"),
        isView: false,
        dataTestIdSet: new Set([{
          selectorValue: createPomStringPattern("MaintenanceItemsMaintenanceItemSelector-Search-input", "static", []),
          pom: {
            nativeRole: "input",
            methodName: "Search",
            selector: createPomStringPattern("MaintenanceItemsMaintenanceItemSelector-Search-input", "static", []),
            parameters: createPomParameters(["text", "string"], ["annotationText", 'string = ""']),
          },
        }]),
        generatedMethods: new Map([
          ["typeSearch", createPomMethodSignature(createPomParameters(["text", "string"], ["annotationText", 'string = ""']))],
        ]),
      });

      const componentHierarchyMap = new Map<string, IComponentDependencies>([
        ["MaintenanceItemsMaintenanceItemConfiguration", depsParentComponent],
        ["MaintenanceItemsMaintenanceItemSelector", depsChildComponent],
      ]);

      const outDir = path.join(tempRoot, "pom");
      await generateFiles(componentHierarchyMap, new Map(), basePagePath, {
        outDir,
        projectRoot: tempRoot,
        typescriptOutputStructure: "split",
      });

      const componentContent = readFile(path.join(outDir, "MaintenanceItemsMaintenanceItemConfiguration.g.ts"));
      expect(componentContent).toContain('import type { Page as PwPage } from "@playwright/test";');
      expect(componentContent).toContain('import { MaintenanceItemsMaintenanceItemSelector }');
      expect(componentContent).toContain('MaintenanceItemsMaintenanceItemSelector: MaintenanceItemsMaintenanceItemSelector;');
      expect(componentContent).toContain('this.MaintenanceItemsMaintenanceItemSelector = new MaintenanceItemsMaintenanceItemSelector(page);');
    }
    finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("supports vueRouterFluentChaining by emitting route metadata and goToSelf/goTo methods", async () => {
    const tempRoot = makeTempRoot("vue-pom-router-fluent-");

    try {
      // Router introspection uses a Vite SSR server rooted at the router entry folder.
      // Ensure bare imports like "vue-router" can be resolved.
      const thisDir = path.dirname(fileURLToPath(import.meta.url));
      const frontendNodeModules = path.resolve(thisDir, "..", "node_modules");
      const tempNodeModules = path.join(tempRoot, "node_modules");
      if (!fs.existsSync(tempNodeModules)) {
        fs.symlinkSync(frontendNodeModules, tempNodeModules, "dir");
      }

      const basePagePath = path.join(tempRoot, "base-page.ts");
      writeMinimalBasePage(basePagePath);

      // The route introspector expects imported .vue files to exist.
      writeFile(path.join(tempRoot, "UsersView.vue"), "<template><div /></template>\n");

      // Router entry.
      writeFile(
        path.join(tempRoot, "router.ts"),
        [
          "import { createMemoryHistory, createRouter } from 'vue-router';",
          "import UsersView from './UsersView.vue';",
          "",
          "export default function makeRouter() {",
          "  return createRouter({",
          "    history: createMemoryHistory(),",
          "    routes: [",
          "      {",
          "        path: '/users/:id',",
          "        name: 'users',",
          "        component: UsersView,",
          "      },",
          "    ],",
          "  });",
          "}",
          "",
        ].join("\n"),
      );

      // Add a toggle test id so the view gets a constructor (lets us cover testIdAttribute trimming too).
      const depsUsersView = makeDeps({
        filePath: path.join(tempRoot, "UsersView.vue"),
        isView: true,
        dataTestIdSet: new Set([{ selectorValue: createPomStringPattern("UsersView-EnableSessionEmails-toggle", "static", []) }]),
      });

      // Provide custom widget helpers so the generated file has imports for ToggleWidget.
      writeFile(
        path.join(tempRoot, "tests", "playwright", "pom", "custom", "Toggle.ts"),
        "export class Toggle { constructor(_page: any, _testId: string) {} }\n",
      );

      const componentHierarchyMap = new Map<string, IComponentDependencies>([["UsersView", depsUsersView]]);
      const outDir = path.join(tempRoot, "pom");

      await generateFiles(componentHierarchyMap, new Map(), basePagePath, {
        outDir,
        projectRoot: tempRoot,
        vueRouterFluentChaining: true,
        routerEntry: "./router.ts",
        testIdAttribute: " data-qa ",
      });

      const aggregatedFile = path.join(outDir, "page-object-models.g.ts");
      const content = readFile(aggregatedFile);

      // Route metadata + goTo helpers. The named route drives the runtime router via push.
      expect(content).toContain("static readonly route");
      expect(content).toContain("async goTo()");
      expect(content).toContain("__appRouter?.push(");
      expect(content).toContain('name: "users"');
      expect(content).toContain("await this.page.evaluate(async ({ name, params })");

      // Trim + propagate testIdAttribute into BasePage super call.
      expect(content).toContain("super(page, { testIdAttribute: \"data-qa\" });");

      // ToggleWidget instance generated.
      expect(content).toContain("new ToggleWidget(page, \"UsersView-EnableSessionEmails-toggle\")");

      // And validate the error case: enabling fluent chaining without routerEntry.
      await expect(
        generateFiles(componentHierarchyMap, new Map(), basePagePath, {
          outDir: path.join(tempRoot, "pom2"),
          projectRoot: tempRoot,
          vueRouterFluentChaining: true,
        }),
      ).rejects.toThrow("Router entry path is required");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 120_000);

  it("emits a parametrized goTo(params) that drives the runtime router via push({ name, params })", async () => {
    const tempRoot = makeTempRoot("vue-pom-router-parametrized-");

    try {
      const thisDir = path.dirname(fileURLToPath(import.meta.url));
      const frontendNodeModules = path.resolve(thisDir, "..", "node_modules");
      const tempNodeModules = path.join(tempRoot, "node_modules");
      if (!fs.existsSync(tempNodeModules)) {
        fs.symlinkSync(frontendNodeModules, tempNodeModules, "dir");
      }

      const basePagePath = path.join(tempRoot, "base-page.ts");
      writeMinimalBasePage(basePagePath);

      // One component per scenario:
      //   DashboardView  -> paramless route only (/dashboard)
      //   UsersView      -> parametrized route only (/users/:id, props declare `id`)
      //   PersonsView    -> BOTH (/persons/new paramless, /persons/:id parametrized)
      //   OrgMembersView -> multi-param route (/orgs/:orgId/users/:userId)
      //   ThingsView     -> optional param route (/things/:thingId?)
      writeFile(path.join(tempRoot, "DashboardView.vue"), "<template><div /></template>\n");
      writeFile(path.join(tempRoot, "UsersView.vue"), "<template><div /></template>\n");
      writeFile(path.join(tempRoot, "PersonsView.vue"), "<template><div /></template>\n");
      writeFile(path.join(tempRoot, "OrgMembersView.vue"), "<template><div /></template>\n");
      writeFile(path.join(tempRoot, "ThingsView.vue"), "<template><div /></template>\n");

      writeFile(
        path.join(tempRoot, "router.ts"),
        [
          "import { createMemoryHistory, createRouter } from 'vue-router';",
          "import DashboardView from './DashboardView.vue';",
          "import UsersView from './UsersView.vue';",
          "import PersonsView from './PersonsView.vue';",
          "import OrgMembersView from './OrgMembersView.vue';",
          "import ThingsView from './ThingsView.vue';",
          "",
          "export default function makeRouter() {",
          "  return createRouter({",
          "    history: createMemoryHistory(),",
          "    routes: [",
          "      { path: '/dashboard', name: 'dashboard', component: DashboardView },",
          "      { path: '/users/:id', name: 'users', component: UsersView, props: (route) => ({ id: route.params.id }) },",
          "      { path: '/persons/new', name: 'persons-new', component: PersonsView },",
          "      { path: '/persons/:id', name: 'persons-edit', component: PersonsView, props: (route) => ({ id: route.params.id }) },",
          "      { path: '/orgs/:orgId/users/:userId', name: 'org-members', component: OrgMembersView, props: (route) => ({ orgId: route.params.orgId, userId: route.params.userId }) },",
          "      { path: '/things/:thingId?', name: 'things', component: ThingsView, props: (route) => ({ thingId: route.params.thingId }) },",
          "    ],",
          "  });",
          "}",
          "",
        ].join("\n"),
      );

      const mkView = (name: string, fileName: string) => [
        name,
        makeDeps({
          filePath: path.join(tempRoot, fileName),
          isView: true,
          dataTestIdSet: new Set<IDataTestId>([{ selectorValue: createPomStringPattern(`${name}-Sample-button`, "static", []) }]),
        }),
      ] as const;

      const componentHierarchyMap = new Map<string, IComponentDependencies>([
        mkView("DashboardView", "DashboardView.vue"),
        mkView("UsersView", "UsersView.vue"),
        mkView("PersonsView", "PersonsView.vue"),
        mkView("OrgMembersView", "OrgMembersView.vue"),
        mkView("ThingsView", "ThingsView.vue"),
      ]);
      const outDir = path.join(tempRoot, "pom");

      await generateFiles(componentHierarchyMap, new Map(), basePagePath, {
        outDir,
        projectRoot: tempRoot,
        vueRouterFluentChaining: true,
        routerEntry: "./router.ts",
      });

      const content = readFile(path.join(outDir, "page-object-models.g.ts"));

      // Extract one class block regardless of the (alphabetical) emit order.
      const extractClass = (name: string): string => {
        const start = content.indexOf(`export class ${name}`);
        expect(start, `class ${name} should be generated`).toBeGreaterThan(-1);
        const nextClass = content.indexOf("export class ", start + 1);
        return nextClass === -1 ? content.slice(start) : content.slice(start, nextClass);
      };

      // Shared: named routes drive the runtime router, handing it a params object (undefined
      // values stripped) instead of reconstructing a URL. Warm pages SPA-push via
      // `__appRouter.push`; cold pages (about:blank, router not yet installed) boot then
      // full-load the resolved target (`__appRouter.resolve(...).href`) so the route's
      // component mounts via a stable page load instead of a race-prone SPA push.
      const PUSH_CALL = "__appRouter?.push(";
      const RESOLVE_CALL = "__appRouter?.resolve(";
      const COLD_BOOT = 'this.page.goto("/", { waitUntil: "commit" })';
      const COLD_TARGET_LOAD = 'await this.page.goto(href, { waitUntil: "domcontentloaded" })';
      const COLD_START_WAIT = "waitForFunction(() => typeof";
      const IS_COLD = "const isCold =";

      // --- DashboardView: paramless-only, named -> no-arg goTo() that pushes the named route. ---
      const dashboardClass = extractClass("DashboardView");
      expect(dashboardClass).toContain('name: "dashboard"');
      expect(dashboardClass).toContain(PUSH_CALL);
      // Cold-start branch: boot "/", wait for the router, resolve the target, full-load it.
      expect(dashboardClass).toContain(IS_COLD);
      expect(dashboardClass).toContain(COLD_BOOT);
      expect(dashboardClass).toContain(COLD_START_WAIT);
      expect(dashboardClass).toContain(RESOLVE_CALL);
      expect(dashboardClass).toContain(COLD_TARGET_LOAD);
      // A paramless route has no params object: emit an empty record literally (no Object.fromEntries).
      expect(dashboardClass).toContain("const routeParams = {};");
      expect(dashboardClass).not.toContain("goTo(params");
      expect(dashboardClass).not.toContain("targetUrl");
      expect(dashboardClass).not.toContain("replaceAll");

      // --- UsersView: parametrized-only, named -> goTo(params) that pushes with the param object. ---
      const usersClass = extractClass("UsersView");
      expect(usersClass).toContain("async goTo(params: { id: string | number })");
      expect(usersClass).toContain('name: "users"');
      // Required params are never nullish, so no `?? {}` guard (avoids TS2871).
      expect(usersClass).toContain("Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined))");
      expect(usersClass).toContain(PUSH_CALL);
      expect(usersClass).toContain(RESOLVE_CALL);
      expect(usersClass).toContain(IS_COLD);
      // No no-arg overload signature for a parametrized-only route.
      expect(usersClass).not.toMatch(/goTo\(\): Promise<void>/);
      expect(usersClass).not.toContain("targetUrl");
      expect(usersClass).not.toContain("replaceAll");
      // route property still holds the tokenized template (informational; goTo uses push).
      expect(usersClass).toContain('{ template: "/users/__VUE_TESTID_PARAM__id__" }');

      // --- PersonsView: BOTH routes, both named -> overloaded goTo() selecting the route name by params presence. ---
      const personsClass = extractClass("PersonsView");
      // Overload signatures precede the implementation.
      expect(personsClass).toContain("goTo(): Promise<void>;");
      expect(personsClass).toContain("goTo(params: { id: string | number }): Promise<void>;");
      // The route name is selected by params presence and inlined into the router call args
      // (no separate `const routeName`, no URL reconstruction from tokens).
      expect(personsClass).toContain('name: params ? "persons-edit" : "persons-new"');
      // The both-routes overload is also guarded: cold branch resolves + full-loads the target.
      expect(personsClass).toContain(IS_COLD);
      expect(personsClass).toContain(COLD_BOOT);
      expect(personsClass).toContain(COLD_START_WAIT);
      expect(personsClass).toContain(RESOLVE_CALL);
      expect(personsClass).toContain(COLD_TARGET_LOAD);
      expect(personsClass).toContain("Object.fromEntries(Object.entries(params ?? {})");
      expect(personsClass).toContain(PUSH_CALL);
      // Implementation parameter is optional (so the no-arg overload is callable).
      expect(personsClass).toContain("async goTo(params?: { id: string | number })");
      expect(personsClass).not.toContain("targetUrl");
      expect(personsClass).not.toContain("replaceAll");
      // route property is the shortest (paramless) template.
      expect(personsClass).toContain('{ template: "/persons/new" }');

      // --- OrgMembersView: multi-param, named -> goTo(params) pushing both params. ---
      const orgMembersClass = extractClass("OrgMembersView");
      expect(orgMembersClass).toContain("async goTo(params: { orgId: string | number; userId: string | number })");
      expect(orgMembersClass).toContain('name: "org-members"');
      expect(orgMembersClass).toContain("Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined))");
      expect(orgMembersClass).toContain(PUSH_CALL);
      expect(orgMembersClass).not.toContain("targetUrl");
      expect(orgMembersClass).not.toContain("replaceAll");

      // --- ThingsView: optional param, named -> goTo(params?: { thingId? }) that omits it when undefined. ---
      const thingsClass = extractClass("ThingsView");
      // The only param is optional, so the params object itself is optional — `goTo()` is valid
      // and navigates with the optional segment omitted.
      expect(thingsClass).toContain("async goTo(params?: { thingId?: string | number })");
      expect(thingsClass).toContain('name: "things"');
      // undefined values are stripped before handing the object to the router, so an omitted
      // optional param is simply not passed — the router builds /things (segment omitted),
      // never /things/undefined. Because params is optional, the `?? {}` guard is used.
      expect(thingsClass).toContain("Object.fromEntries(Object.entries(params ?? {}).filter(([, v]) => v !== undefined))");
      expect(thingsClass).toContain(PUSH_CALL);
      expect(thingsClass).not.toContain("targetUrl");
      expect(thingsClass).not.toContain("replaceAll");
      // route property holds the tokenized template (informational; the only route).
      expect(thingsClass).toContain('{ template: "/things/__VUE_TESTID_PARAM__thingId__" }');
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 120_000);

  it("supports lazy route components when route naming depends on explicit page directories", async () => {
    const tempRoot = makeTempRoot("vue-pom-router-lazy-generated-");

    try {
      const thisDir = path.dirname(fileURLToPath(import.meta.url));
      const frontendNodeModules = path.resolve(thisDir, "..", "node_modules");
      const tempNodeModules = path.join(tempRoot, "node_modules");
      if (!fs.existsSync(tempNodeModules)) {
        fs.symlinkSync(frontendNodeModules, tempNodeModules, "dir");
      }

      const basePagePath = path.join(tempRoot, "base-page.ts");
      writeMinimalBasePage(basePagePath);

      writeFile(path.join(tempRoot, "src", "views", "msp-instances", "List.vue"), "<template><div /></template>\n");
      writeFile(
        path.join(tempRoot, "src", "router.ts"),
        [
          "import { createMemoryHistory, createRouter } from 'vue-router';",
          "",
          "export default function makeRouter() {",
          "  return createRouter({",
          "    history: createMemoryHistory(),",
          "    routes: [",
          "      {",
          "        path: '/msp-instances',",
          "        name: 'msp-instances',",
          "        component: () => import('@/views/msp-instances/List.vue'),",
          "      },",
          "    ],",
          "  });",
          "}",
          "",
        ].join("\n"),
      );

      const viewPath = path.join(tempRoot, "src", "views", "msp-instances", "List.vue");
      const componentHierarchyMap = new Map<string, IComponentDependencies>([
        [
          "List",
          makeDeps({
            filePath: viewPath,
            isView: true,
            dataTestIdSet: new Set<IDataTestId>([{ selectorValue: createPomStringPattern("List-FetchData-button", "static", []) }]),
          }),
        ],
      ]);
      const vueFilesPathMap = new Map<string, string>([["List", viewPath]]);
      const outDir = path.join(tempRoot, "pom");

      await generateFiles(componentHierarchyMap, vueFilesPathMap, basePagePath, {
        outDir,
        projectRoot: tempRoot,
        vueRouterFluentChaining: true,
        routerEntry: "./src/router.ts",
        pageDirs: ["src/views/msp-instances"],
        componentDirs: ["src/components"],
        layoutDirs: ["src/layouts"],
      });

      const aggregatedFile = path.join(outDir, "page-object-models.g.ts");
      const content = readFile(aggregatedFile);

      expect(content).toContain("export class List extends BasePage");
      expect(content).toContain("template: \"/msp-instances\"");
      expect(content).not.toContain("static readonly route: { template: string } | null = null;");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 120_000);

  it("generates valid PascalCase class names for kebab-case and dot-separated component names", async () => {
    // Regression test: class-generation/index.ts used the raw componentName in the class
    // declaration instead of converting it to PascalCase first.  Names like "error-test" and
    // "FirmsGrid.client" are valid Vue file names but are illegal TypeScript identifiers, so the
    // generated file would fail to compile.
    const tempRoot = makeTempRoot("vue-pom-pascal-");

    try {
      const basePagePath = path.join(tempRoot, "base-page.ts");
      writeMinimalBasePage(basePagePath);

      const componentHierarchyMap = new Map<string, IComponentDependencies>([
        [
          "error-test",
          makeDeps({
            filePath: path.join(tempRoot, "src", "views", "error-test.vue"),
            isView: true,
          }),
        ],
        [
          "FirmsGrid.client",
          makeDeps({
            filePath: path.join(tempRoot, "src", "components", "FirmsGrid.client.vue"),
            isView: false,
          }),
        ],
        [
          "forgot-password",
          makeDeps({
            filePath: path.join(tempRoot, "src", "views", "forgot-password.vue"),
            isView: true,
          }),
        ],
        [
          "template-library",
          makeDeps({
            filePath: path.join(tempRoot, "src", "views", "template-library.vue"),
            isView: true,
          }),
        ],
      ]);

      const outDir = path.join(tempRoot, "pom");

      await generateFiles(componentHierarchyMap, new Map(), basePagePath, {
        outDir,
        projectRoot: tempRoot,
      });

      const pomPath = path.join(outDir, "page-object-models.g.ts");
      expect(fs.existsSync(pomPath)).toBe(true);

      const content = readFile(pomPath);

      // Valid PascalCase class names must be emitted.
      expect(content).toContain("export class ErrorTest extends BasePage");
      expect(content).toContain("export class FirmsGridClient extends BasePage");
      expect(content).toContain("export class ForgotPassword extends BasePage");
      expect(content).toContain("export class TemplateLibrary extends BasePage");

      // The raw (illegal) names must NOT appear as class declarations.
      expect(content).not.toMatch(/export class error-test/);
      expect(content).not.toMatch(/export class FirmsGrid\.client/);
      expect(content).not.toMatch(/export class forgot-password/);
      expect(content).not.toMatch(/export class template-library/);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("threads human-readable locator descriptions through generated Playwright getters and actions", async () => {
    const tempRoot = makeTempRoot("vue-pom-described-locators-");

    try {
      const basePagePath = path.join(tempRoot, "base-page.ts");
      writeMinimalBasePage(basePagePath);

      const componentHierarchyMap = new Map<string, IComponentDependencies>([
        [
          "UserListPage",
          makeDeps({
            filePath: path.join(tempRoot, "src", "views", "UserListPage.vue"),
            isView: true,
            dataTestIdSet: new Set<IDataTestId>([
              {
                selectorValue: createPomStringPattern("UserListPage-Search-input", "static", []),
                pom: {
                  nativeRole: "input",
                  methodName: "Search",
                  selector: createPomStringPattern("UserListPage-Search-input", "static", []),
                  parameters: createPomParameters(["text", "string"], ["annotationText", "string = \"\""]),
                },
              },
              {
                selectorValue: createPomStringPattern("UserListPage-Save-button", "static", []),
                pom: {
                  nativeRole: "button",
                  methodName: "Save",
                  selector: createPomStringPattern("UserListPage-Save-button", "static", []),
                  parameters: [],
                },
              },
            ]),
          }),
        ],
      ]);

      const outDir = path.join(tempRoot, "pom");
      await generateFiles(componentHierarchyMap, new Map(), basePagePath, {
        outDir,
        projectRoot: tempRoot,
      });

      const content = readFile(path.join(outDir, "page-object-models.g.ts"));

      expect(content).toContain('return this.locatorByTestId("UserListPage-Search-input", "User list search input");');
      expect(content).toContain('await this.fillInputByTestId("UserListPage-Search-input", text, annotationText, "User list search input");');
      expect(content).toContain('return this.locatorByTestId("UserListPage-Save-button", "User list save button");');
      expect(content).toContain('await this.clickByTestId("UserListPage-Save-button", annotationText, wait, "User list save button");');
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("C#: fails fast when parameterized selectors omit key params", async () => {
    const tempRoot = makeTempRoot("vue-pom-csharp-dyn-input-");

    try {
      const dt: IDataTestId = {
        selectorValue: createPomStringPattern("items-check-${key}", "parameterized", ["key"]),
        pom: {
          nativeRole: "input",
          methodName: "ItemsCheckByKey",
          selector: createPomStringPattern("items-check-${key}", "parameterized", ["key"]),
          parameters: createPomParameters(["text", "string"], ["annotationText", "string = \"\""]),
        },
      };

      const componentHierarchyMap = new Map<string, IComponentDependencies>([
        [
          "ItemsPage",
          makeDeps({
            filePath: path.join(tempRoot, "src", "views", "ItemsPage.vue"),
            isView: true,
            dataTestIdSet: new Set([dt]),
          }),
        ],
      ]);

      const outDir = path.join(tempRoot, "pom");
      const basePagePath = path.join(tempRoot, "base-page.ts");
      await expect(generateFiles(componentHierarchyMap, new Map(), basePagePath, {
        outDir,
        emitLanguages: ["csharp"],
        csharp: { namespace: "Test.Generated" },
      })).rejects.toThrow(/Missing selector parameter\(s\) "key"/);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("C#: fails fast when parameterized selectors omit non-key template variables", async () => {
    const tempRoot = makeTempRoot("vue-pom-csharp-selector-vars-");

    try {
      const dt: IDataTestId = {
        selectorValue: createPomStringPattern("items-check-${itemId}", "parameterized", ["itemId"]),
        pom: {
          nativeRole: "input",
          methodName: "ItemsCheckByKey",
          selector: createPomStringPattern("items-check-${itemId}", "parameterized", ["itemId"]),
          // Simulate stale/manual IR that forgot to carry the selector variable name.
          parameters: createPomParameters(["text", "string"], ["annotationText", "string = \"\""]),
        },
      };

      const componentHierarchyMap = new Map<string, IComponentDependencies>([
        [
          "ItemsPage",
          makeDeps({
            filePath: path.join(tempRoot, "src", "views", "ItemsPage.vue"),
            isView: true,
            dataTestIdSet: new Set([dt]),
          }),
        ],
      ]);

      const outDir = path.join(tempRoot, "pom");
      const basePagePath = path.join(tempRoot, "base-page.ts");
      await expect(generateFiles(componentHierarchyMap, new Map(), basePagePath, {
        outDir,
        emitLanguages: ["csharp"],
        csharp: { namespace: "Test.Generated" },
      })).rejects.toThrow(/Missing selector parameter\(s\) "itemId"/);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("C#: input actions resolve editable descendants before filling text", async () => {
    const tempRoot = makeTempRoot("vue-pom-csharp-editable-locator-");

    try {
      const dt: IDataTestId = {
        selectorValue: createPomStringPattern("TenantSelectBox-StateSelectedTenant-input", "static", []),
        pom: {
          nativeRole: "input",
          methodName: "StateSelectedTenant",
          selector: createPomStringPattern("TenantSelectBox-StateSelectedTenant-input", "static", []),
          parameters: createPomParameters(["text", "string"], ["annotationText", "string = \"\""]),
        },
      };

      const componentHierarchyMap = new Map<string, IComponentDependencies>([
        [
          "TenantSelectBox",
          makeDeps({
            filePath: path.join(tempRoot, "src", "components", "TenantSelectBox.vue"),
            dataTestIdSet: new Set([dt]),
          }),
        ],
      ]);

      const outDir = path.join(tempRoot, "pom");
      const basePagePath = path.join(tempRoot, "base-page.ts");
      writeMinimalBasePage(basePagePath);
      await generateFiles(componentHierarchyMap, new Map(), basePagePath, {
        outDir,
        emitLanguages: ["csharp"],
        csharp: { namespace: "Test.Generated" },
      });

      const cs = readFile(path.join(outDir, "page-object-models.g.cs"));

      expect(cs).toContain("protected async Task<ILocator> ResolveEditableLocatorAsync(ILocator locator)");
      expect(cs).toContain("var editableLocator = await ResolveEditableLocatorAsync(StateSelectedTenantInput);");
      expect(cs).toContain("await editableLocator.FillAsync(text);");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("c#: navigation methods return on success without leaving unreachable code after terminal throws", async () => {
    const tempRoot = makeTempRoot("vue-pom-csharp-nav-return-");

    try {
      const keyedNav: IDataTestId = {
        selectorValue: createPomStringPattern("NavHost-${value}-mynavitem", "parameterized", ["value"]),
        pom: {
          nativeRole: "button",
          methodName: "ValueByKey",
          selector: createPomStringPattern("NavHost-${key}-mynavitem", "parameterized", ["key"]),
          parameters: createPomParameters(["key", "string"]),
        },
        targetPageObjectModelClass: "UsersPage",
      };

      const alternateNav: IDataTestId = {
        selectorValue: createPomStringPattern("NavHost-SystemUpdate-routerlink", "static", []),
        pom: {
          nativeRole: "button",
          methodName: "SystemUpdate",
          selector: createPomStringPattern("NavHost-SystemUpdate-routerlink", "static", []),
          alternateSelectors: [createPomStringPattern("NavHost-Update-routerlink", "static", [])],
          parameters: [],
        },
        targetPageObjectModelClass: "SystemUpdatePage",
      };

      const componentHierarchyMap = new Map<string, IComponentDependencies>([
        [
          "NavHost",
          makeDeps({
            filePath: path.join(tempRoot, "src", "components", "NavHost.vue"),
            isView: false,
            dataTestIdSet: new Set([keyedNav, alternateNav]),
          }),
        ],
      ]);

      const outDir = path.join(tempRoot, "pom");
      const basePagePath = path.join(tempRoot, "base-page.ts");
      writeMinimalBasePage(basePagePath);
      await generateFiles(componentHierarchyMap, new Map(), basePagePath, {
        outDir,
        emitLanguages: ["csharp"],
        csharp: { namespace: "Test.Generated" },
      });

      const csFile = path.join(outDir, "page-object-models.g.cs");
      const cs = readFile(csFile);

      expect(cs).toContain("await ValueByKeyButton(key).ClickAsync();\n        return new UsersPage(Page);");
      expect(cs).not.toContain(
        "throw lastError ?? new System.Exception(\"[pom] Failed to navigate using any candidate test id.\");\n"
        + "        return new SystemUpdatePage(Page);",
      );
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
