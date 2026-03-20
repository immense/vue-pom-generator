// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { IComponentDependencies, IDataTestId } from "../utils";
import { generateFiles } from "../class-generation";

function writeFile(filePath: string, content: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
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
      "}",
      "",
    ].join("\n"),
  );

	// The generator now also inlines Pointer.ts. Provide a minimal stub next to BasePage.ts.
	const pointerPath = path.join(path.dirname(filePath), "Pointer.ts");
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
      const basePagePath = path.join(tempRoot, "BasePage.ts");
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
      expect(defaultFixtureContent).toContain("usersPage: Pom.UsersPage");
      expect(defaultFixtureContent).toContain("thingWidget: Pom.ThingWidget");
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
      expect(runtimeClassGenGitAttributesContent).toContain("BasePage.ts linguist-generated");
      expect(runtimeClassGenGitAttributesContent).toContain("Pointer.ts linguist-generated");
      expect(runtimeClassGenGitAttributesContent).toContain("playwright-types.ts linguist-generated");

      // 2) explicit file path
      await generateFiles(componentHierarchyMap, new Map(), basePagePath, {
        outDir,
        projectRoot: tempRoot,
        generateFixtures: "tests/playwright/fixture/CustomFixtures.ts",
      });

      const explicitFixturePath = path.join(tempRoot, "tests", "playwright", "fixture", "CustomFixtures.ts");
      expect(fs.existsSync(explicitFixturePath)).toBe(true);
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
      const basePagePath = path.join(tempRoot, "BasePage.ts");
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
      const basePagePath = path.join(tempRoot, "BasePage.ts");
      writeMinimalBasePage(basePagePath);

      // Create a referenced target view that will NOT be in componentHierarchyMap.
      // The generator should emit a stub class for it.
      writeFile(
        path.join(tempRoot, "src", "views", "NewTenantPage.vue"),
        [
          "<template>",
          "  <TenantDetailsEditForm />",
          "</template>",
          "",
        ].join("\n"),
      );

      const dt: IDataTestId = {
        value: "TenantListPage-NewTenant-routerlink",
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
        dataTestIdSet: new Set([{ value: "TenantDetailsEditForm-Name-input" }]),
        generatedMethods: new Map([
          ["typeTenantName", { params: "name: string", argNames: ["name"] }],
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

      const basePagePath = path.join(tempRoot, "BasePage.ts");
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
        dataTestIdSet: new Set([{ value: "UsersView-EnableSessionEmails-toggle" }]),
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

      // Route metadata + goToSelf helpers
      expect(content).toContain("static readonly route");
      expect(content).toContain("async goToSelf()");
      expect(content).toContain("await this.page.goto(route.template)");

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

  it("generates valid PascalCase class names for kebab-case and dot-separated component names", async () => {
    // Regression test: class-generation/index.ts used the raw componentName in the class
    // declaration instead of converting it to PascalCase first.  Names like "error-test" and
    // "FirmsGrid.client" are valid Vue file names but are illegal TypeScript identifiers, so the
    // generated file would fail to compile.
    const tempRoot = makeTempRoot("vue-pom-pascal-");

    try {
      const basePagePath = path.join(tempRoot, "BasePage.ts");
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

  it("C#: dynamic-test-id input element generates key+text params so the locator compiles", async () => {
    // Regression: when an <input> has :data-testid="`...-${key}`", the C# generator was
    // emitting `(string text, string annotationText = "")` but the locator body referenced
    // `{key}` — causing a CS0103 compile error.  Both params must appear together.
    //
    // Simulate the broken state: params lacks `key` (as utils.ts incorrectly deletes it
    // for input elements with dynamic test IDs).  The C# generator must add it when the
    // formattedDataTestId contains `${key}`.
    const tempRoot = makeTempRoot("vue-pom-csharp-dyn-input-");

    try {
      const dt: IDataTestId = {
        value: "items-check-${key}",
        pom: {
          nativeRole: "input",
          methodName: "ItemsCheckByKey",
          formattedDataTestId: "items-check-${key}",
          // Broken params as currently produced by utils.ts: key is absent
          params: { text: "string", annotationText: "string = \"\"" },
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
      await generateFiles(componentHierarchyMap, new Map(), null as any, {
        outDir,
        emitLanguages: ["csharp"],
        csharp: { namespace: "Test.Generated" },
      });

      const csFile = path.join(outDir, "page-object-models.g.cs");
      const cs = readFile(csFile);
      const csGitAttributesPath = path.join(outDir, ".gitattributes");
      expect(fs.existsSync(csGitAttributesPath)).toBe(true);
      expect(readFile(csGitAttributesPath)).toContain("page-object-models.g.cs linguist-generated");

      // The locator must include key as a parameter, not just text.
      expect(cs).toContain("string key");
      // Locator body must use {key} interpolation.
      expect(cs).toContain("items-check-{key}");
      // The method must compile: key must not be an undeclared reference.
      // (If key appears only in the template but not in the signature, C# throws CS0103.)
      expect(cs).toMatch(/ItemsCheckByKeyInput\(string key/);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
