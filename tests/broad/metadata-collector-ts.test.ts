// @vitest-environment node
import { describe, expect, it } from "vitest";

import { type ElementNode, ElementTypes, type TemplateChildNode } from "@vue/compiler-core";

import { createMetadataCollectorTransform, type ElementMetadata } from "../../metadata-collector";
import {
  makeAttributeNode,
  makeElementNode as makeTypedElementNode,
  makeSimpleExpression,
  makeTextNode,
  makeTransformContext,
  makeVNodeCall,
} from "../helpers/typed-mocks";

function makeElementNode(overrides: Partial<ElementNode> = {}): ElementNode {
  return {
    ...makeTypedElementNode({
      tag: "button",
      tagType: ElementTypes.ELEMENT,
      props: [makeAttributeNode("data-testid", "submit-button")],
      children: [],
      codegenNode: makeVNodeCall({
        patchFlag: 2,
        dynamicProps: makeSimpleExpression('["class"]'),
      }),
    }),
    ...overrides,
  } as ElementNode;
}

/**
 * Run the metadata-collector transform over one element and return the collected
 * metadata map (the transform's exit hook is invoked, like the compiler would).
 */
function runCollector(options: { el?: ElementNode | TemplateChildNode, debug?: boolean, component?: string, semanticNames?: Array<[string, string]> } = {}) {
  const metadataMap = new Map<string, Map<string, ElementMetadata>>();
  const semanticNameMap = new Map<string, string>(options.semanticNames ?? []);
  const transform = createMetadataCollectorTransform(
    options.component ?? "Comp",
    metadataMap,
    semanticNameMap,
    options.debug ?? false,
  );

  const onExit = transform(options.el ?? makeElementNode(), makeTransformContext());
  if (typeof onExit === "function")
    onExit();

  return { metadataMap, semanticNameMap };
}

/** Capture console.log lines while `run` executes, restoring the original afterwards. */
function captureLogs(run: () => void): string[] {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.join(" "));
  };
  try {
    run();
  }
  finally {
    console.log = originalLog;
  }
  return logs;
}

describe("metadata-collector.ts createMetadataCollectorTransform", () => {
  it("normalizes a null/whitespace testIdAttribute to the default (line 50)", () => {
    // null/undefined testIdAttribute falls back to default after trim/empty-coalesce.
    const metadataMap = new Map<string, Map<string, ElementMetadata>>();
    const semanticNameMap = new Map<string, string>();
    const transformNull = createMetadataCollectorTransform(
      "Comp",
      metadataMap,
      semanticNameMap,
      false,
      // @ts-expect-error intentionally null testIdAttribute to exercise the default-fallback path (line 50)
      null,
    );
    const onExit = transformNull(makeElementNode(), makeTransformContext());
    if (typeof onExit === "function")
      onExit();
    expect(metadataMap.get("Comp")?.get("submit-button")).toBeTruthy();

    // whitespace-only testIdAttribute normalizes to default.
    const metadataMap2 = new Map<string, Map<string, ElementMetadata>>();
    const transformWs = createMetadataCollectorTransform(
      "Comp",
      metadataMap2,
      semanticNameMap,
      false,
      "   ",
    );
    const onExit2 = transformWs(makeElementNode(), makeTransformContext());
    if (typeof onExit2 === "function")
      onExit2();
    expect(metadataMap2.get("Comp")?.get("submit-button")).toBeTruthy();
  });

  it("uses the default testIdAttribute when the argument is omitted (line 50 default param)", () => {
    // Omit the 5th argument entirely to exercise the default parameter value.
    const { metadataMap } = runCollector();
    expect(metadataMap.get("Comp")?.get("submit-button")).toBeTruthy();
  });

  it("returns an exit function that returns early for non-element nodes (lines 56-57)", () => {
    // A text node is not an element: the transform returns an exit function that collects nothing.
    const { metadataMap } = runCollector({ el: makeTextNode("x") });
    expect(metadataMap.size).toBe(0);
  });

  it("emits debug logs when debug is enabled (lines 63-69)", () => {
    const logs = captureLogs(() => runCollector({ debug: true }));

    // Debug logs from metadata-collector exit function.
    expect(logs.some((l) => l.includes("[metadata] Checking <button>"))).toBe(true);
    expect(logs.some((l) => l.includes("codegenNode exists: true"))).toBe(true);
    expect(logs.some((l) => l.includes("codegenNode.type:"))).toBe(true);
    expect(logs.some((l) => l.includes("tagType="))).toBe(true);
    expect(logs.some((l) => l.includes("testId=\"submit-button\""))).toBe(true);
  });

  it("logs an empty testId string when no testId prop exists in debug mode (line 65 null branch)", () => {
    // Element with no data-testid prop -> getTestIdFromProp returns null -> debugTestId ?? "" yields "".
    const logs = captureLogs(() => runCollector({ debug: true, el: makeElementNode({ props: [] }) }));

    expect(logs.some((l) => l.includes('testId=""'))).toBe(true);
  });

  it("logs codegenNode exists: false in debug mode when codegenNode is missing", () => {
    const logs = captureLogs(() => runCollector({ debug: true, el: makeElementNode({ codegenNode: undefined }) }));

    expect(logs.some((l) => l.includes("codegenNode exists: false"))).toBe(true);
    // No codegenNode.type log line because codegenNode is falsy.
    expect(logs.some((l) => l.includes("codegenNode.type:"))).toBe(false);
  });

  it("returns early when metadata cannot be created (lines 82-83)", () => {
    // Element has no data-testid prop, so tryCreateElementMetadata returns null.
    const { metadataMap } = runCollector({ el: makeElementNode({ props: [] }) });

    expect(metadataMap.size).toBe(0);
  });

  it("returns early when codegenNode is missing so metadata is null (lines 82-83)", () => {
    const { metadataMap } = runCollector({ el: makeElementNode({ codegenNode: undefined }) });

    expect(metadataMap.size).toBe(0);
  });

  it("creates and stores a new component map when none exists yet (line 86)", () => {
    const { metadataMap } = runCollector({ component: "FreshComp", semanticNames: [["submit-button", "submit"]] });

    // The component map did not exist before; it should be created now.
    expect(metadataMap.has("FreshComp")).toBe(true);
    const entry = metadataMap.get("FreshComp")?.get("submit-button");
    expect(entry).toBeTruthy();
    expect(entry!.semanticName).toBe("submit");
  });

  it("reuses an existing component map when it already exists (line 86 reuse + line 90 set)", () => {
    const existing = new Map<string, ElementMetadata>([
      ["existing-id", { testId: "existing-id", tag: "button", tagType: ElementTypes.ELEMENT }],
    ]);
    const metadataMap = new Map<string, Map<string, ElementMetadata>>([["Comp", existing]]);
    const semanticNameMap = new Map<string, string>();
    const transform = createMetadataCollectorTransform(
      "Comp",
      metadataMap,
      semanticNameMap,
      false,
    );

    const onExit = transform(makeElementNode(), makeTransformContext());
    if (typeof onExit === "function")
      onExit();

    // Same map instance reused, now containing both entries.
    expect(metadataMap.get("Comp")).toBe(existing);
    expect(existing.get("existing-id")).toBeTruthy();
    expect(existing.get("submit-button")).toBeTruthy();
  });
});
