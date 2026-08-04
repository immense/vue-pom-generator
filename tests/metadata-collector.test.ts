// @vitest-environment node
import { describe, expect, it } from "vitest";

import { ElementTypes } from "@vue/compiler-core";

import { createMetadataCollectorTransform, type ElementMetadata } from "../metadata-collector";
import {
  makeAttributeNode,
  makeElementNode,
  makeSimpleExpression,
  makeTransformContext,
  makeVNodeCall,
} from "./helpers/typed-mocks";

describe("metadata-collector", () => {
  it("collects element metadata when semantic name is known", () => {
    const metadataMap = new Map<string, Map<string, ElementMetadata>>();
    const semanticNameMap = new Map<string, string>([
      ["Comp-create-button", "create"],
    ]);

    const transform = createMetadataCollectorTransform(
      "Test",
      metadataMap,
      semanticNameMap,
      false,
      "data-testid",
    );

    // We don't need a full compiler pipeline to test this.
    // The collector only needs an ElementNode with a data-testid prop and a VNODE_CALL codegenNode.
    const elementNode = makeElementNode({
      tag: "button",
      tagType: ElementTypes.ELEMENT,
      props: [makeAttributeNode("data-testid", "Comp-create-button")],
      children: [],
      codegenNode: makeVNodeCall({
        patchFlag: 2,
        dynamicProps: makeSimpleExpression('["class"]'),
      }),
    });

    const onExit = transform(elementNode, makeTransformContext());
    if (typeof onExit === "function") {
      onExit();
    }

    const meta = metadataMap.get("Test")?.get("Comp-create-button");
    expect(meta).toBeTruthy();
    expect(meta!.semanticName).toBe("create");
    expect(meta!.tag).toBe("button");

    // If Vue emitted dynamicProps/patchFlag, our helper should decode class.
    // We don't assert exact patchFlag values (Vue may change), just behavior.
    if (meta!.dynamicProps) {
      expect(meta!.dynamicProps).toContain("class");
    }
    if (meta!.patchFlag) {
      expect(meta!.hasDynamicClass).toBe(true);
    }
  });

  it("honors a custom testIdAttribute (with trimming/normalization)", () => {
    const metadataMap = new Map<string, Map<string, ElementMetadata>>();
    const semanticNameMap = new Map<string, string>([
      ["QA-thing", "thing"],
    ]);

    const transform = createMetadataCollectorTransform(
      "Test",
      metadataMap,
      semanticNameMap,
      false,
      "  data-qa  ",
    );

    const elementNode = makeElementNode({
      tag: "div",
      tagType: ElementTypes.ELEMENT,
      props: [makeAttributeNode("data-qa", "QA-thing")],
      children: [],
      codegenNode: makeVNodeCall({
        patchFlag: 4,
        dynamicProps: makeSimpleExpression('["style"]'),
      }),
    });

    const onExit = transform(elementNode, makeTransformContext());
    if (typeof onExit === "function") {
      onExit();
    }

    const meta = metadataMap.get("Test")?.get("QA-thing");
    expect(meta).toBeTruthy();
    expect(meta!.semanticName).toBe("thing");
    expect(meta!.tag).toBe("div");
  });
});
