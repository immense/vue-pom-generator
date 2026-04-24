// @vitest-environment node
import { describe, expect, it } from "vitest";

import { createTestIdsVirtualModulesPlugin } from "../plugin/support/virtual-modules";
import { createPomParameterSpec } from "../pom-params";
import { createPomStringPattern } from "../pom-patterns";
import type { IComponentDependencies } from "../utils";

function extractCode(loaded: unknown): string {
  return typeof loaded === "string"
    ? loaded
    : (loaded && typeof loaded === "object" && "code" in loaded)
      ? (loaded as { code: string }).code
      : "";
}

function createDependencies(testIds: IComponentDependencies["dataTestIdSet"], options: Partial<IComponentDependencies> = {}): IComponentDependencies {
  return {
    filePath: options.filePath ?? "/repo/src/components/Foo.vue",
    childrenComponentSet: options.childrenComponentSet ?? new Set<string>(),
    usedComponentSet: options.usedComponentSet ?? new Set<string>(),
    dataTestIdSet: testIds,
    isView: options.isView ?? false,
    pomExtraMethods: options.pomExtraMethods,
  };
}

describe("virtual:testids", () => {
  it("serves backwards-compatible ids plus a richer manifest", async () => {
    const componentHierarchyMap = new Map<string, IComponentDependencies>([
      ["Foo", createDependencies(new Set([
        {
          selectorValue: createPomStringPattern("foo-${key}-button", "parameterized"),
          pom: {
            nativeRole: "button",
            methodName: "FooByKey",
            selector: createPomStringPattern("foo-${key}-button", "parameterized"),
            parameters: [createPomParameterSpec("key", "string")],
          },
        },
        {
          selectorValue: createPomStringPattern("foo-name-input", "static"),
          pom: {
            nativeRole: "input",
            methodName: "FooName",
            selector: createPomStringPattern("foo-name-input", "static"),
            parameters: [],
          },
        },
        {
          selectorValue: createPomStringPattern("foo-enabled-checkbox", "static"),
          pom: {
            nativeRole: "checkbox",
            methodName: "FooEnabled",
            selector: createPomStringPattern("foo-enabled-checkbox", "static"),
            parameters: [],
          },
        },
        {
          selectorValue: createPomStringPattern("foo-save-button", "static"),
          pom: {
            nativeRole: "button",
            methodName: "SaveFoo",
            selector: createPomStringPattern("foo-save-button", "static"),
            parameters: [],
          },
        },
      ]), {
        filePath: "/repo/src/views/Foo.vue",
        isView: true,
        pomExtraMethods: [{
          kind: "click",
          name: "clickFirstFoo",
          selector: {
            kind: "testId",
            testId: createPomStringPattern("foo-${key}-button", "parameterized"),
          },
          parameters: [createPomParameterSpec("key", "string")],
        }],
      })],
      ["Bar", createDependencies(new Set([
        {
          selectorValue: createPomStringPattern("bar", "static"),
          pom: {
            nativeRole: "button",
            methodName: "Bar",
            selector: createPomStringPattern("bar", "static"),
            parameters: [],
          },
        },
      ]), {
        filePath: "/repo/src/components/Bar.vue",
      })],
    ]);
    const elementMetadata = new Map([
      ["Foo", new Map([
        ["foo-${key}-button", {
          testId: "foo-${key}-button",
          semanticName: "foo item",
          tag: "button",
          tagType: 0,
          hasClickHandler: true,
          staticTextContent: "Save",
        }],
        ["foo-name-input", {
          testId: "foo-name-input",
          semanticName: "foo name",
          tag: "input",
          tagType: 0,
        }],
        ["foo-enabled-checkbox", {
          testId: "foo-enabled-checkbox",
          semanticName: "enabled",
          tag: "input",
          tagType: 0,
        }],
        ["foo-save-button", {
          testId: "foo-save-button",
          semanticName: "save foo",
          tag: "button",
          tagType: 0,
          hasClickHandler: true,
          staticTextContent: "Save",
        }],
      ])],
    ]);

    const plugin = createTestIdsVirtualModulesPlugin(componentHierarchyMap, elementMetadata, "data-qa");
    expect(typeof plugin).toBe("object");

    const resolved = await (plugin as any).resolveId?.("virtual:testids");
    const resolvedId = typeof resolved === "string" ? resolved : resolved?.id;

    expect(typeof resolvedId).toBe("string");

    const loaded = await (plugin as any).load?.(resolvedId);
    const code = extractCode(loaded);

    expect(code).toContain("export const testIdManifest");
    expect(code).toContain("export const pomManifest");
    expect(code).toContain("export const webMcpManifest");

    expect(code).toContain("\"Bar\"");
    expect(code).toContain("\"bar\"");
    expect(code).toContain("\"Foo\"");
    expect(code).toContain("\"foo-${key}-button\"");
    expect(code).toContain("\"foo-name-input\"");
    expect(code).toContain("\"foo-enabled-checkbox\"");
    expect(code).toContain("\"foo-save-button\"");
    expect(code).toContain("\"generatedPropertyName\": \"FooButton\"");
    expect(code).toContain("\"generatedActionNames\": [");
    expect(code).toContain("\"clickFooByKey\"");
    expect(code).toContain("\"clickFirstFoo\"");
    expect(code).toContain("\"locatorDescription\": \"Foo button\"");
    expect(code).toContain("\"accessibleNameSource\": \"text\"");
    expect(code).toContain("\"needsReview\": false");
    expect(code).toContain("\"sourceFile\": \"/repo/src/views/Foo.vue\"");
    expect(code).toContain("\"kind\": \"view\"");
    expect(code).toContain("\"semanticName\": \"foo item\"");
    expect(code).toContain("\"toolName\": \"foo\"");
    expect(code).toContain("\"toolDescription\": \"Interact with Foo.\"");
    expect(code).toContain("\"toolAutoSubmit\": false");
    expect(code).toContain("\"toolParamDescription\": \"foo name\"");
    expect(code).toContain("\"toolParamDescription\": \"enabled\"");
    expect(code).toContain("\"name\": \"name\"");
    expect(code).toContain("\"name\": \"enabled\"");
    expect(code).toContain("\"name\": \"clickSaveFoo\"");
    expect(code).toContain("\"selectorTemplateVariables\": [");
    expect(code).toContain("\"key\"");

    const resolvedPomManifest = await (plugin as any).resolveId?.("virtual:pom-manifest");
    const resolvedPomManifestId = typeof resolvedPomManifest === "string" ? resolvedPomManifest : resolvedPomManifest?.id;
    const loadedPomManifest = await (plugin as any).load?.(resolvedPomManifestId);
    const pomManifestCode = extractCode(loadedPomManifest);

    expect(pomManifestCode).toContain("export const pomManifest");
    expect(pomManifestCode).not.toContain("export const testIdManifest");
    expect(pomManifestCode).toContain("\"generatedPropertyName\": \"FooButton\"");
    expect(pomManifestCode).toContain("\"locatorDescription\": \"Foo button\"");
    expect(pomManifestCode).toContain("\"accessibleNameSource\": \"text\"");

    const resolvedWebMcpManifest = await (plugin as any).resolveId?.("virtual:webmcp-manifest");
    const resolvedWebMcpManifestId = typeof resolvedWebMcpManifest === "string" ? resolvedWebMcpManifest : resolvedWebMcpManifest?.id;
    const loadedWebMcpManifest = await (plugin as any).load?.(resolvedWebMcpManifestId);
    const webMcpManifestCode = extractCode(loadedWebMcpManifest);

    expect(webMcpManifestCode).toContain("export const webMcpManifest");
    expect(webMcpManifestCode).not.toContain("export const testIdManifest");
    expect(webMcpManifestCode).not.toContain("export const pomManifest");
    expect(webMcpManifestCode).toContain("\"Bar\"");
    expect(webMcpManifestCode).toContain("\"toolName\": \"foo\"");
    expect(webMcpManifestCode).toContain("\"toolName\": \"bar\"");
    expect(webMcpManifestCode).toContain("\"toolAutoSubmit\": true");
    expect(webMcpManifestCode).toContain("\"toolParamDescription\": \"foo name\"");
    expect(webMcpManifestCode).toContain("\"name\": \"clickSaveFoo\"");

    const resolvedWebMcpBridge = await (plugin as any).resolveId?.("virtual:webmcp-bridge");
    const resolvedWebMcpBridgeId = typeof resolvedWebMcpBridge === "string" ? resolvedWebMcpBridge : resolvedWebMcpBridge?.id;
    const loadedWebMcpBridge = await (plugin as any).load?.(resolvedWebMcpBridgeId);
    const webMcpBridgeCode = extractCode(loadedWebMcpBridge);

    expect(webMcpBridgeCode).toContain("registerWebMcpManifestTools");
    expect(webMcpBridgeCode).toContain("registerGeneratedWebMcpTools");
    expect(webMcpBridgeCode).toContain("webMcpTestIdAttribute");
    expect(webMcpBridgeCode).toContain("\"data-qa\"");
    expect(webMcpBridgeCode).toContain("@immense/vue-pom-generator/webmcp-runtime");
    expect(webMcpBridgeCode).toContain("import.meta.hot");

    componentHierarchyMap.set("Baz", createDependencies(new Set([
      {
        selectorValue: createPomStringPattern("baz", "static"),
        pom: {
          nativeRole: "button",
          methodName: "Baz",
          selector: createPomStringPattern("baz", "static"),
          parameters: [],
        },
      },
    ]), {
      filePath: "/repo/src/components/Baz.vue",
    }));

    const loaded2 = await (plugin as any).load?.(resolvedId);
    const code2 = extractCode(loaded2);

    expect(code2).toContain("\"Baz\"");
    expect(code2).toContain("\"baz\"");
  });
});
