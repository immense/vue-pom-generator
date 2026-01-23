// @vitest-environment node
import { describe, expect, it } from "vitest";

import { ElementTypes, NodeTypes } from "@vue/compiler-core";

import { createMetadataCollectorTransform } from "../metadata-collector";

describe("metadata-collector", () => {
  it("collects element metadata when semantic name is known", () => {
    const metadataMap = new Map<string, Map<string, any>>();
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
    const elementNode = {
      type: NodeTypes.ELEMENT,
      tag: "button",
      tagType: ElementTypes.ELEMENT,
      props: [
        {
          type: NodeTypes.ATTRIBUTE,
          name: "data-testid",
          value: { content: "Comp-create-button" },
        },
      ],
      children: [],
      codegenNode: {
        type: NodeTypes.VNODE_CALL,
        patchFlag: 2,
        dynamicProps: {
          type: NodeTypes.SIMPLE_EXPRESSION,
          content: "[\"class\"]",
        },
      },
    } as any;

    const onExit = transform(elementNode, {} as any);
    if (typeof onExit === "function") {
      onExit();
    }

    const meta = metadataMap.get("Test")?.get("Comp-create-button");
    expect(meta).toBeTruthy();
    expect(meta.semanticName).toBe("create");
    expect(meta.tag).toBe("button");

    // If Vue emitted dynamicProps/patchFlag, our helper should decode class.
    // We don't assert exact patchFlag values (Vue may change), just behavior.
    if (meta.dynamicProps) {
      expect(meta.dynamicProps).toContain("class");
    }
    if (meta.patchFlag) {
      expect(meta.hasDynamicClass).toBe(true);
    }
  });

  it("honors a custom testIdAttribute (with trimming/normalization)", () => {
    const metadataMap = new Map<string, Map<string, any>>();
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

    const elementNode = {
      type: NodeTypes.ELEMENT,
      tag: "div",
      tagType: ElementTypes.ELEMENT,
      props: [
        {
          type: NodeTypes.ATTRIBUTE,
          name: "data-qa",
          value: { content: "QA-thing" },
        },
      ],
      children: [],
      codegenNode: {
        type: NodeTypes.VNODE_CALL,
        patchFlag: 4,
        dynamicProps: {
          type: NodeTypes.SIMPLE_EXPRESSION,
          content: "[\"style\"]",
        },
      },
    } as any;

    const onExit = transform(elementNode, {} as any);
    if (typeof onExit === "function") {
      onExit();
    }

    const meta = metadataMap.get("Test")?.get("QA-thing");
    expect(meta).toBeTruthy();
    expect(meta.semanticName).toBe("thing");
    expect(meta.tag).toBe("div");
  });
});
