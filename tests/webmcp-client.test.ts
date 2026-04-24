// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanupWebModelContext, initializeWebModelContext } from "@mcp-b/global";

import { buildWebMcpManifest } from "../manifest-generator";
import { createPomParameterSpec } from "../pom-params";
import { createPomStringPattern } from "../pom-patterns";
import type { IComponentDependencies } from "../utils";

const TEST_INIT_OPTIONS = {
  transport: {
    tabServer: {
      allowedOrigins: [window.location.origin] as string[],
    },
    iframeServer: false,
  },
  installTestingShim: true,
} as const;

type ModelContextToolSchema = {
  type: string;
  properties?: Record<string, {
    type: string;
    description?: string;
  }>;
};

type ModelContextTool = {
  name: string;
  description: string;
  inputSchema?: ModelContextToolSchema;
};

type ModelContextLike = {
  registerTool(tool: {
    name: string;
    description: string;
    inputSchema?: ModelContextToolSchema;
    execute(args: Record<string, unknown>): Promise<{
      content: Array<{
        type: string;
        text: string;
      }>;
    }>;
  }): unknown;
  listTools(): ModelContextTool[];
  callTool(params: {
    name: string;
    arguments: Record<string, unknown>;
  }): Promise<{
    content: Array<{
      type: string;
      text: string;
    }>;
  }>;
};

afterEach(() => {
  try {
    cleanupWebModelContext();
  }
  catch {
    // Best-effort cleanup only.
  }
});

function createDependencies(testIds: IComponentDependencies["dataTestIdSet"], options: Partial<IComponentDependencies> = {}): IComponentDependencies {
  return {
    filePath: options.filePath ?? "/repo/src/views/Foo.vue",
    childrenComponentSet: options.childrenComponentSet ?? new Set<string>(),
    usedComponentSet: options.usedComponentSet ?? new Set<string>(),
    dataTestIdSet: testIds,
    isView: options.isView ?? true,
    pomExtraMethods: options.pomExtraMethods,
  };
}

function requireModelContext(): ModelContextLike {
  const modelContext = (navigator as Navigator & { modelContext?: ModelContextLike }).modelContext;
  if (!modelContext) {
    throw new Error("Expected navigator.modelContext to be available");
  }

  return modelContext;
}

function buildFixtureManifest() {
  const componentHierarchyMap = new Map<string, IComponentDependencies>([
    ["Foo", createDependencies(new Set([
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
      {
        selectorValue: createPomStringPattern("foo-${key}-button", "parameterized"),
        pom: {
          nativeRole: "button",
          methodName: "FooByKey",
          selector: createPomStringPattern("foo-${key}-button", "parameterized"),
          parameters: [createPomParameterSpec("key", "string")],
        },
      },
    ]))],
  ]);
  const elementMetadata = new Map([
    ["Foo", new Map([
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
      }],
      ["foo-${key}-button", {
        testId: "foo-${key}-button",
        semanticName: "foo item",
        tag: "button",
        tagType: 0,
        hasClickHandler: true,
      }],
    ])],
  ]);

  return buildWebMcpManifest(componentHierarchyMap, elementMetadata);
}

function buildInputSchema(tool: {
  params: Array<{ name: string; role: string; toolParamDescription: string }>;
}) {
  return {
    type: "object",
    properties: Object.fromEntries(tool.params.map(param => [
      param.name,
      {
        type: param.role === "checkbox" ? "boolean" : "string",
        description: param.toolParamDescription,
      },
    ])),
    required: [],
    additionalProperties: false,
  } as const;
}

function registerManifestTools(modelContext: ModelContextLike, manifest: ReturnType<typeof buildFixtureManifest>): void {
  for (const component of Object.values(manifest)) {
    for (const tool of component.tools) {
      modelContext.registerTool({
        name: tool.toolName,
        description: tool.toolDescription,
        inputSchema: buildInputSchema(tool),
        async execute(args: Record<string, unknown>) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                component: component.componentName,
                tool: tool.toolName,
                args,
                actions: tool.actions.map(action => action.name),
              }),
            }],
          };
        },
      });
    }
  }
}

describe("webMcpManifest with a WebMCP runtime", () => {
  it("registers manifest-derived tools and executes them through navigator.modelContext", async () => {
    const webMcpManifest = buildFixtureManifest();

    cleanupWebModelContext();
    initializeWebModelContext(TEST_INIT_OPTIONS);

    const modelContext = requireModelContext();
    registerManifestTools(modelContext, webMcpManifest);

    const tools = modelContext.listTools();

    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      name: "foo",
      description: "Interact with Foo.",
      inputSchema: {
        type: "object",
        properties: {
          enabled: {
            type: "boolean",
            description: "enabled",
          },
          name: {
            type: "string",
            description: "foo name",
          },
        },
      },
    });

    const result = await modelContext.callTool({
      name: "foo",
      arguments: {
        name: "Ayla",
        enabled: true,
      },
    });

    expect(result).toMatchObject({
      content: [{
        type: "text",
        text: JSON.stringify({
          component: "Foo",
          tool: "foo",
          args: {
            name: "Ayla",
            enabled: true,
          },
          actions: ["clickFooByKey", "clickSaveFoo"],
        }),
      }],
    });
  });
});
