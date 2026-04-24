// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanupWebModelContext, initializeWebModelContext } from "@mcp-b/global";

import { buildWebMcpManifest } from "../manifest-generator";
import { createPomParameterSpec } from "../pom-params";
import { createPomStringPattern } from "../pom-patterns";
import type { IComponentDependencies } from "../utils";
import type { WebMcpModelContextLike, WebMcpRouteLike, WebMcpRouterLike } from "../webmcp-runtime";
import { registerRouteScopedWebMcpManifestTools, registerWebMcpManifestTools } from "../webmcp-runtime";

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

function createTestingRouter(initialRoute: WebMcpRouteLike, options: { withReady?: boolean } = {}) {
  let afterEachHandler: ((to: WebMcpRouteLike) => void) | null = null;
  const currentRoute = { value: initialRoute };
  let resolveReady: (() => void) | null = null;
  const readyPromise = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const router: WebMcpRouterLike = {
    currentRoute,
    afterEach(guard) {
      afterEachHandler = guard;
      return () => {
        if (afterEachHandler === guard) {
          afterEachHandler = null;
        }
      };
    },
    ...(options.withReady
      ? {
          isReady() {
            return readyPromise;
          },
        }
      : {}),
  };

  return {
    router,
    navigate(nextRoute: WebMcpRouteLike, notify = true) {
      currentRoute.value = nextRoute;
      if (notify) {
        afterEachHandler?.(nextRoute);
      }
    },
    resolveReady() {
      resolveReady?.();
    },
  };
}

function createMatchedRoute(componentName: string): WebMcpRouteLike {
  return {
    matched: [{
      components: {
        default: {
          name: componentName,
        },
      },
    }],
  };
}

function buildFixtureManifest() {
  const componentHierarchyMap = new Map<string, IComponentDependencies>([
    ["FooRoute", createDependencies(new Set(), {
      filePath: "/repo/src/views/FooRoute.vue",
      isView: true,
      usedComponentSet: new Set(["Foo"]),
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

    expect([...registration.toolNames].sort()).toEqual(["bar", "foo_by_key", "save_foo"]);

    const tools = modelContext.listTools();
    const barTool = tools.find(tool => tool.name === "bar");
    const fooByKeyTool = tools.find(tool => tool.name === "foo_by_key");
    const saveFooTool = tools.find(tool => tool.name === "save_foo");

    expect(tools).toHaveLength(3);
    expect(barTool).toMatchObject({
      name: "bar",
      description: "Click bar on Bar.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    });
    expect(fooByKeyTool).toMatchObject({
      name: "foo_by_key",
      description: "Click foo by key on Foo.",
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
        },
      },
    });
    expect(saveFooTool).toMatchObject({
      name: "save_foo",
      description: "Click save foo on Foo.",
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

    const fooByKeyResult = await modelContext.callTool({
      name: "foo_by_key",
      arguments: {
        name: "Ayla",
        enabled: true,
        key: "alpha",
        notes: "hello",
      },
    });

    expect(nameInput.value).toBe("Ayla");
    expect(enabledCheckbox.checked).toBe(true);
    expect(notesInput.value).toBe("hello");
    expect(saveClicks).toBe(0);
    expect(rowClicks).toBe(1);
    expect(fooByKeyResult.content[0]?.type).toBe("text");
    expect(JSON.parse(fooByKeyResult.content[0]?.text ?? "null")).toEqual({
      component: "Foo",
      tool: "foo_by_key",
      appliedParameters: ["enabled", "name", "notes"],
      selectorVariablesUsed: ["key"],
      action: "clickFooByKey",
    });

    const saveFooResult = await modelContext.callTool({
      name: "save_foo",
      arguments: {
        name: "Bea",
      },
    });

    expect(nameInput.value).toBe("Bea");
    expect(saveClicks).toBe(1);
    expect(rowClicks).toBe(1);
    expect(saveFooResult.content[0]?.type).toBe("text");
    expect(JSON.parse(saveFooResult.content[0]?.text ?? "null")).toEqual({
      component: "Foo",
      tool: "save_foo",
      appliedParameters: ["name"],
      selectorVariablesUsed: [],
      action: "clickSaveFoo",
    });

    registration.unregister();
    expect(modelContext.listTools()).toHaveLength(0);
  });

  it("can scope manifest-derived tools to the active route view tree", () => {
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

    cleanupWebModelContext();
    initializeWebModelContext(TEST_INIT_OPTIONS);

    const modelContext = requireModelContext();
    const { router, navigate } = createTestingRouter(createMatchedRoute("FooRoute"));
    const registration = registerRouteScopedWebMcpManifestTools({
      manifest: webMcpManifest,
      modelContext,
      router,
      root: document.body,
      testIdAttribute: "data-qa",
    });

    expect([...registration.toolNames].sort()).toEqual(["foo_by_key", "save_foo"]);
    expect(modelContext.listTools().map(tool => tool.name).sort()).toEqual(["foo_by_key", "save_foo"]);

    navigate(createMatchedRoute("Bar"));

    expect([...registration.toolNames].sort()).toEqual(["bar"]);
    expect(modelContext.listTools().map(tool => tool.name).sort()).toEqual(["bar"]);

    navigate(createMatchedRoute("MissingRoute"));

    expect(registration.toolNames).toEqual([]);
    expect(modelContext.listTools()).toEqual([]);

    registration.unregister();
    expect(modelContext.listTools()).toHaveLength(0);
  });

  it("refreshes route-scoped tools after router.isReady resolves initial navigation", async () => {
    const webMcpManifest = buildFixtureManifest();

    document.body.innerHTML = `
      <div>
        <form>
          <input data-qa="foo-name-input" />
          <button type="button" data-qa="foo-save-button">Save</button>
          <button type="button" data-qa="foo-alpha-button">Row</button>
        </form>
      </div>
    `;

    cleanupWebModelContext();
    initializeWebModelContext(TEST_INIT_OPTIONS);

    const modelContext = requireModelContext();
    const { router, navigate, resolveReady } = createTestingRouter({ matched: [] }, { withReady: true });
    const registration = registerRouteScopedWebMcpManifestTools({
      manifest: webMcpManifest,
      modelContext,
      router,
      root: document.body,
      testIdAttribute: "data-qa",
    });

    expect(registration.toolNames).toEqual([]);

    navigate(createMatchedRoute("FooRoute"), false);
    resolveReady();
    await Promise.resolve();

    expect([...registration.toolNames].sort()).toEqual(["foo_by_key", "save_foo"]);
    expect(modelContext.listTools().map(tool => tool.name).sort()).toEqual(["foo_by_key", "save_foo"]);

    registration.unregister();
    expect(modelContext.listTools()).toHaveLength(0);
  });
});
