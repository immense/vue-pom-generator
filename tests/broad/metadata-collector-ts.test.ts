// @vitest-environment node
import { describe, expect, it } from "vitest";

import { type ElementNode, ElementTypes } from "@vue/compiler-core";

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

describe("metadata-collector.ts createMetadataCollectorTransform", () => {
  it("normalizes a null/whitespace testIdAttribute to the default (line 50)", () => {
    const metadataMap = new Map<string, Map<string, ElementMetadata>>();
    const semanticNameMap = new Map<string, string>();

    // null/undefined testIdAttribute falls back to default after trim/empty-coalesce.
    const transformNull = createMetadataCollectorTransform(
      "Comp",
      metadataMap,
      semanticNameMap,
      false,
      // @ts-expect-error intentionally null testIdAttribute to exercise the default-fallback path (line 50)
      null,
    );
    const el = makeElementNode();
    const onExit = transformNull(el, makeTransformContext());
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
    const metadataMap = new Map<string, Map<string, ElementMetadata>>();
    const semanticNameMap = new Map<string, string>();
    // Omit the 5th argument entirely to exercise the default parameter value.
    const transform = createMetadataCollectorTransform(
      "Comp",
      metadataMap,
      semanticNameMap,
      false,
    );
    const onExit = transform(makeElementNode(), makeTransformContext());
    if (typeof onExit === "function")
      onExit();
    expect(metadataMap.get("Comp")?.get("submit-button")).toBeTruthy();
  });

  it("returns an exit function that returns early for non-element nodes (lines 56-57)", () => {
    const metadataMap = new Map<string, Map<string, ElementMetadata>>();
    const semanticNameMap = new Map<string, string>();
    const transform = createMetadataCollectorTransform(
      "Comp",
      metadataMap,
      semanticNameMap,
      false,
    );

    const interpolationNode = makeTextNode("x");
    const onExit = transform(interpolationNode, makeTransformContext());
    expect(typeof onExit).toBe("function");
    if (typeof onExit === "function")
      onExit();
    // Nothing should have been collected.
    expect(metadataMap.size).toBe(0);
  });

  it("emits debug logs when debug is enabled (lines 63-69)", () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.join(" "));
    };
    try {
      const metadataMap = new Map<string, Map<string, ElementMetadata>>();
      const semanticNameMap = new Map<string, string>();
      const transform = createMetadataCollectorTransform(
        "Comp",
        metadataMap,
        semanticNameMap,
        true,
      );

      const el = makeElementNode();
      const onExit = transform(el, makeTransformContext());
      if (typeof onExit === "function")
        onExit();

      // Debug logs from metadata-collector exit function.
      expect(logs.some((l) => l.includes("[metadata] Checking <button>"))).toBe(true);
      expect(logs.some((l) => l.includes("codegenNode exists: true"))).toBe(true);
      expect(logs.some((l) => l.includes("codegenNode.type:"))).toBe(true);
      expect(logs.some((l) => l.includes("tagType="))).toBe(true);
      expect(logs.some((l) => l.includes("testId=\"submit-button\""))).toBe(true);
    }
    finally {
      console.log = originalLog;
    }
  });

  it("logs an empty testId string when no testId prop exists in debug mode (line 65 null branch)", () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.join(" "));
    };
    try {
      const metadataMap = new Map<string, Map<string, ElementMetadata>>();
      const semanticNameMap = new Map<string, string>();
      const transform = createMetadataCollectorTransform(
        "Comp",
        metadataMap,
        semanticNameMap,
        true,
      );

      // Element with no data-testid prop -> getTestIdFromProp returns null -> debugTestId ?? "" yields "".
      const el = makeElementNode({ props: [] });
      const onExit = transform(el, makeTransformContext());
      if (typeof onExit === "function")
        onExit();

      expect(logs.some((l) => l.includes('testId=""'))).toBe(true);
      expect(metadataMap.size).toBe(0);
    }
    finally {
      console.log = originalLog;
    }
  });

  it("logs codegenNode exists: false in debug mode when codegenNode is missing", () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.join(" "));
    };
    try {
      const metadataMap = new Map<string, Map<string, ElementMetadata>>();
      const semanticNameMap = new Map<string, string>();
      const transform = createMetadataCollectorTransform(
        "Comp",
        metadataMap,
        semanticNameMap,
        true,
      );

      const el = makeElementNode({ codegenNode: undefined });
      const onExit = transform(el, makeTransformContext());
      if (typeof onExit === "function")
        onExit();

      expect(logs.some((l) => l.includes("codegenNode exists: false"))).toBe(true);
      // No codegenNode.type log line because codegenNode is falsy.
      expect(logs.some((l) => l.includes("codegenNode.type:"))).toBe(false);
    }
    finally {
      console.log = originalLog;
    }
  });

  it("returns early when metadata cannot be created (lines 82-83)", () => {
    const metadataMap = new Map<string, Map<string, ElementMetadata>>();
    const semanticNameMap = new Map<string, string>();
    const transform = createMetadataCollectorTransform(
      "Comp",
      metadataMap,
      semanticNameMap,
      false,
    );

    // Element has no data-testid prop, so tryCreateElementMetadata returns null.
    const el = makeElementNode({ props: [] });
    const onExit = transform(el, makeTransformContext());
    if (typeof onExit === "function")
      onExit();

    expect(metadataMap.size).toBe(0);
  });

  it("returns early when codegenNode is missing so metadata is null (lines 82-83)", () => {
    const metadataMap = new Map<string, Map<string, ElementMetadata>>();
    const semanticNameMap = new Map<string, string>();
    const transform = createMetadataCollectorTransform(
      "Comp",
      metadataMap,
      semanticNameMap,
      false,
    );

    const el = makeElementNode({ codegenNode: undefined });
    const onExit = transform(el, makeTransformContext());
    if (typeof onExit === "function")
      onExit();

    expect(metadataMap.size).toBe(0);
  });

  it("creates and stores a new component map when none exists yet (line 86)", () => {
    const metadataMap = new Map<string, Map<string, ElementMetadata>>();
    const semanticNameMap = new Map<string, string>([["submit-button", "submit"]]);
    const transform = createMetadataCollectorTransform(
      "FreshComp",
      metadataMap,
      semanticNameMap,
      false,
    );

    const onExit = transform(makeElementNode(), makeTransformContext());
    if (typeof onExit === "function")
      onExit();

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
