// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanupWebModelContext, initializeWebModelContext } from "@mcp-b/global";

import { buildWebMcpManifest } from "../manifest-generator";
import { createPomParameterSpec } from "../pom-params";
import { createPomStringPattern } from "../pom-patterns";
import type { IComponentDependencies } from "../utils";
import type { WebMcpModelContextLike } from "../webmcp-runtime";
import { registerWebMcpManifestTools } from "../webmcp-runtime";

const TEST_INIT_OPTIONS = {
  transport: {
    tabServer: {
      allowedOrigins: [window.location.origin] as string[],
    },
    iframeServer: false,
  },
  installTestingShim: true,
} as const;

type TestingModelContext = WebMcpModelContextLike & {
  listTools(): Array<{
    name: string;
    description: string;
    inputSchema?: {
      type: string;
      properties?: Record<string, {
        type: string;
        description?: string;
        enum?: string[];
      }>;
    };
  }>;
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
  document.body.innerHTML = "";
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

function requireModelContext(): TestingModelContext {
  const modelContext = (navigator as Navigator & { modelContext?: TestingModelContext }).modelContext;
  if (!modelContext) {
    throw new Error("Expected navigator.modelContext to be available");
  }

  return modelContext;
}

function buildFixtureManifest() {
  const componentHierarchyMap = new Map<string, IComponentDependencies>([
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
      isView: false,
    })],
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
        selectorValue: createPomStringPattern("foo-${key}-notes-input", "parameterized"),
        pom: {
          nativeRole: "input",
          methodName: "FooNotesByKey",
          selector: createPomStringPattern("foo-${key}-notes-input", "parameterized"),
          parameters: [createPomParameterSpec("key", "string")],
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
    ]), {
      filePath: "/repo/src/views/Foo.vue",
      isView: true,
    })],
  ]);
  const elementMetadata = new Map([
    ["Bar", new Map([
      ["bar", {
        testId: "bar",
        semanticName: "bar",
        tag: "button",
        tagType: 0,
        hasClickHandler: true,
      }],
    ])],
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
      ["foo-${key}-notes-input", {
        testId: "foo-${key}-notes-input",
        semanticName: "foo notes",
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

describe("webMcp runtime bridge", () => {
  it("registers manifest-derived tools and drives DOM controls through navigator.modelContext", async () => {
    const webMcpManifest = buildFixtureManifest();

    document.body.innerHTML = `
      <div>
        <button type="button" data-qa="bar">Bar</button>
        <form>
          <input data-qa="foo-name-input" />
          <input type="checkbox" data-qa="foo-enabled-checkbox" />
          <input data-qa="foo-alpha-notes-input" />
          <button type="button" data-qa="foo-save-button">Save</button>
          <button type="button" data-qa="foo-alpha-button">Row</button>
        </form>
      </div>
    `;

    const barButton = document.querySelector("[data-qa='bar']") as HTMLButtonElement;
    const nameInput = document.querySelector("[data-qa='foo-name-input']") as HTMLInputElement;
    const enabledCheckbox = document.querySelector("[data-qa='foo-enabled-checkbox']") as HTMLInputElement;
    const notesInput = document.querySelector("[data-qa='foo-alpha-notes-input']") as HTMLInputElement;
    const saveButton = document.querySelector("[data-qa='foo-save-button']") as HTMLButtonElement;
    const rowButton = document.querySelector("[data-qa='foo-alpha-button']") as HTMLButtonElement;

    let barClicks = 0;
    let saveClicks = 0;
    let rowClicks = 0;
    barButton.addEventListener("click", () => {
      barClicks += 1;
    });
    saveButton.addEventListener("click", () => {
      saveClicks += 1;
    });
    rowButton.addEventListener("click", () => {
      rowClicks += 1;
    });

    cleanupWebModelContext();
    initializeWebModelContext(TEST_INIT_OPTIONS);

    const modelContext = requireModelContext();
    const registration = registerWebMcpManifestTools({
      manifest: webMcpManifest,
      modelContext,
      root: document.body,
      testIdAttribute: "data-qa",
    });

    expect([...registration.toolNames].sort()).toEqual(["bar", "foo"]);

    const tools = modelContext.listTools();
    const barTool = tools.find(tool => tool.name === "bar");
    const fooTool = tools.find(tool => tool.name === "foo");

    expect(tools).toHaveLength(2);
    expect(barTool).toMatchObject({
      name: "bar",
      description: "Interact with Bar. Calling this tool clicks clickBar.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    });
    expect(fooTool).toMatchObject({
      name: "foo",
      description: "Interact with Foo. Use submitAction to choose one of: clickFooByKey, clickSaveFoo.",
      inputSchema: {
        type: "object",
        properties: {
          enabled: {
            type: "boolean",
            description: "enabled",
          },
          key: {
            type: "string",
            description: "Variable used to resolve parameterized generated selectors.",
          },
          name: {
            type: "string",
            description: "foo name",
          },
          notes: {
            type: "string",
            description: "foo notes",
          },
          submitAction: {
            type: "string",
            description: "Optional generated action to click after applying parameters.",
            enum: ["clickFooByKey", "clickSaveFoo"],
          },
        },
      },
    });

    const barResult = await modelContext.callTool({
      name: "bar",
      arguments: {},
    });
    expect(barClicks).toBe(1);
    expect(barResult.content[0]?.type).toBe("text");
    expect(JSON.parse(barResult.content[0]?.text ?? "null")).toEqual({
      component: "Bar",
      tool: "bar",
      appliedParameters: [],
      selectorVariablesUsed: [],
      action: "clickBar",
    });

    const fooResult = await modelContext.callTool({
      name: "foo",
      arguments: {
        name: "Ayla",
        enabled: true,
        key: "alpha",
        notes: "hello",
        submitAction: "clickFooByKey",
      },
    });

    expect(nameInput.value).toBe("Ayla");
    expect(enabledCheckbox.checked).toBe(true);
    expect(notesInput.value).toBe("hello");
    expect(saveClicks).toBe(0);
    expect(rowClicks).toBe(1);
    expect(fooResult.content[0]?.type).toBe("text");
    expect(JSON.parse(fooResult.content[0]?.text ?? "null")).toEqual({
      component: "Foo",
      tool: "foo",
      appliedParameters: ["enabled", "name", "notes"],
      selectorVariablesUsed: ["key"],
      action: "clickFooByKey",
    });

    registration.unregister();
    expect(modelContext.listTools()).toHaveLength(0);
  });
});
