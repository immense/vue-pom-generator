// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  type AttributeNode,
  type CommentNode,
  type DirectiveNode,
  type ElementNode,
  type InterpolationNode,
  type SimpleExpressionNode,
  type SourceLocation,
  NodeTypes,
} from "@vue/compiler-core";
import { PatchFlags } from "@vue/shared";

import {
  findDataTestIdProp,
  getTestIdFromProp,
  parseDynamicProps,
  tryCreateElementMetadata,
} from "../../compiler-metadata-utils";
import {
  makeAttributeNode,
  makeDirectiveNode,
  makeElementNode,
  makeSimpleExpression,
  makeTextNode,
  makeVNodeCall,
} from "../helpers/typed-mocks";

function loc(): SourceLocation {
  return {
    start: { offset: 0, line: 1, column: 1 },
    end: { offset: 0, line: 1, column: 1 },
    source: "",
  };
}

function expr(content: string): SimpleExpressionNode {
  return makeSimpleExpression(content);
}

function makeInterpolationNode(): InterpolationNode {
  return { type: NodeTypes.INTERPOLATION, content: makeSimpleExpression(""), loc: loc() };
}

function makeCommentNode(): CommentNode {
  return { type: NodeTypes.COMMENT, content: "", loc: loc() };
}

function makeElement(overrides: Partial<ElementNode> = {}): ElementNode {
  const el = makeElementNode({
    ...(overrides.tag !== undefined ? { tag: overrides.tag } : {}),
    ...(overrides.tagType !== undefined ? { tagType: overrides.tagType } : {}),
    ...(overrides.props !== undefined ? { props: overrides.props } : {}),
    ...(overrides.children !== undefined ? { children: overrides.children } : {}),
  });
  const result = { ...el, ...overrides } as ElementNode;
  if (!overrides.loc) {
    result.loc = {
      start: { offset: 0, line: 7, column: 3 },
      end: { offset: 0, line: 7, column: 3 },
      source: "",
    };
  }
  return result;
}

describe("compiler-metadata-utils.ts getTestIdFromProp", () => {
  it("returns null when prop is undefined", () => {
    expect(getTestIdFromProp(undefined)).toBeNull();
  });

  it("returns the content of a static attribute with a value", () => {
    expect(
      getTestIdFromProp(makeAttributeNode("data-testid", "abc")),
    ).toBe("abc");
  });

  it("returns null for a static attribute with no value", () => {
    expect(
      getTestIdFromProp(makeAttributeNode("data-testid")),
    ).toBeNull();
  });

  it("returns the expression content of a bind directive with a simple expression", () => {
    expect(
      getTestIdFromProp(makeDirectiveNode("bind", { arg: expr("data-testid"), exp: expr("someId") })),
    ).toBe("someId");
  });

  it("returns null for a bind directive whose exp is not a simple expression", () => {
    expect(
      getTestIdFromProp(makeDirectiveNode("bind", { arg: expr("data-testid") })),
    ).toBeNull();
  });

  it("returns null for a prop that is neither attribute nor directive", () => {
    const prop = makeInterpolationNode();
    // @ts-expect-error intentionally passing a non-attribute/directive node to exercise the null-return path
    expect(getTestIdFromProp(prop)).toBeNull();
  });
});

describe("compiler-metadata-utils.ts findDataTestIdProp", () => {
  it("finds a static attribute by default name", () => {
    const el = makeElement({
      props: [makeAttributeNode("data-testid", "x")],
    });
    expect(findDataTestIdProp(el)?.type).toBe(NodeTypes.ATTRIBUTE);
  });

  it("finds a bind directive by custom attribute name", () => {
    const el = makeElement({
      props: [makeDirectiveNode("bind", { arg: expr("data-qa"), exp: expr("y") })],
    });
    const prop = findDataTestIdProp(el, "data-qa");
    expect(prop?.type).toBe(NodeTypes.DIRECTIVE);
  });

  it("returns undefined when no matching prop exists", () => {
    expect(findDataTestIdProp(makeElement())).toBeUndefined();
  });
});

describe("compiler-metadata-utils.ts parseDynamicProps", () => {
  it("returns undefined for falsy input", () => {
    expect(parseDynamicProps(undefined)).toBeUndefined();
    expect(parseDynamicProps("")).toBeUndefined();
  });

  it("parses a comma-delimited string, trimming and dropping empty tokens", () => {
    expect(parseDynamicProps("a, b ,c")).toEqual(["a", "b", "c"]);
    // Empty middle token (token.length === 0 branch) and empty last token (last.length === 0 branch).
    expect(parseDynamicProps("a,,b,")).toEqual(["a", "b"]);
    // Empty leading token.
    expect(parseDynamicProps(",a")).toEqual(["a"]);
  });

  it("parses a JSON array simple expression", () => {
    expect(parseDynamicProps(expr('["class", "style"]'))).toEqual(["class", "style"]);
  });

  it("returns undefined when JSON array parsing fails (catch branch)", () => {
    expect(parseDynamicProps(expr("[not valid json]"))).toBeUndefined();
  });

  it("wraps a non-array simple expression in a single-element array", () => {
    expect(parseDynamicProps(expr("class"))).toEqual(["class"]);
  });

  it("returns undefined for an unrecognized input type", () => {
    // @ts-expect-error intentionally passing an unrecognized input type to exercise the undefined-return path
    expect(parseDynamicProps({ random: true })).toBeUndefined();
  });
});

describe("compiler-metadata-utils.ts tryCreateElementMetadata", () => {
  const semanticNameMap = new Map<string, string>([["my-btn", "create"]]);

  function makeTestIdEl(opts: {
    testId?: string;
    bindTestId?: string;
    codegenNode?: ElementNode["codegenNode"];
    props?: Array<AttributeNode | DirectiveNode>;
    children?: ElementNode["children"];
    tag?: string;
  }): ElementNode {
    const testId = opts.testId;
    const bindTestId = opts.bindTestId;
    const props: Array<AttributeNode | DirectiveNode> = opts.props ?? [];
    if (testId !== undefined) {
      props.unshift(makeAttributeNode("data-testid", testId));
    }
    else if (bindTestId !== undefined) {
      props.unshift(makeDirectiveNode("bind", { arg: expr("data-testid"), exp: expr(bindTestId) }));
    }
    return makeElement({
      tag: opts.tag ?? "button",
      props,
      children: opts.children ?? [],
      codegenNode: opts.codegenNode,
    });
  }

  it("returns null when there is no test id prop", () => {
    const el = makeElement({ codegenNode: makeVNodeCall() });
    expect(tryCreateElementMetadata({
      element: el,
      semanticNameMap,
      debug: false,
      debugPrefix: "[t]",
      preferJsonParseFailureAsContentArray: false,
    })).toBeNull();
  });

  it("returns null when the test id has no value (empty static attribute)", () => {
    const el = makeElement({
      props: [makeAttributeNode("data-testid")],
      codegenNode: makeVNodeCall(),
    });
    expect(tryCreateElementMetadata({
      element: el,
      semanticNameMap,
      debug: false,
      debugPrefix: "[t]",
      preferJsonParseFailureAsContentArray: false,
    })).toBeNull();
  });

  it("returns null when codegenNode is missing or not a VNODE_CALL", () => {
    const el = makeTestIdEl({ testId: "my-btn", codegenNode: undefined });
    expect(tryCreateElementMetadata({
      element: el,
      semanticNameMap,
      debug: false,
      debugPrefix: "[t]",
      preferJsonParseFailureAsContentArray: false,
    })).toBeNull();

    const el2 = makeTestIdEl({ testId: "my-btn", codegenNode: makeSimpleExpression("x") });
    expect(tryCreateElementMetadata({
      element: el2,
      semanticNameMap,
      debug: false,
      debugPrefix: "[t]",
      preferJsonParseFailureAsContentArray: false,
    })).toBeNull();
  });

  it("collects static attributes (aria-label, role, title) and text content from nested children", () => {
    const el = makeTestIdEl({
      testId: "my-btn",
      tag: "button",
      codegenNode: makeVNodeCall({}),
      props: [
        makeAttributeNode("aria-label", "Save"),
        makeAttributeNode("role", "button"),
        makeAttributeNode("title", "Save now"),
      ],
      children: [
        makeTextNode("Hello"),
        makeElementNode({
          tag: "span",
          children: [makeTextNode("world")],
        }),
      ],
    });

    const meta = tryCreateElementMetadata({
      element: el,
      semanticNameMap,
      debug: false,
      debugPrefix: "[t]",
      preferJsonParseFailureAsContentArray: false,
    })!;

    expect(meta).not.toBeNull();
    expect(meta.testId).toBe("my-btn");
    expect(meta.semanticName).toBe("create");
    expect(meta.staticAriaLabel).toBe("Save");
    expect(meta.staticRole).toBe("button");
    expect(meta.staticTitle).toBe("Save now");
    expect(meta.staticTextContent).toBe("Hello world");
    expect(meta.sourceLine).toBe(7);
    expect(meta.sourceColumn).toBe(3);
  });

  it("decodes patch flags and dynamic props from a JSON array dynamicProps", () => {
    const el = makeTestIdEl({
      testId: "my-btn",
      codegenNode: makeVNodeCall({
        patchFlag: PatchFlags.TEXT | PatchFlags.CLASS | PatchFlags.STYLE | PatchFlags.NEED_HYDRATION, // 1 | 2 | 4 | 32 = 39
        dynamicProps: expr('["class", "style", "text"]'),
      }),
    });

    const meta = tryCreateElementMetadata({
      element: el,
      semanticNameMap,
      debug: false,
      debugPrefix: "[t]",
      preferJsonParseFailureAsContentArray: false,
    })!;

    expect(meta.patchFlag).toBe(39);
    expect(meta.dynamicProps).toEqual(["class", "style", "text"]);
    expect(meta.hasClickHandler).toBe(true);
    expect(meta.hasDynamicClass).toBe(true);
    expect(meta.hasDynamicStyle).toBe(true);
    expect(meta.hasDynamicText).toBe(true);
  });

  it("falls back to [] for an unparseable JSON-array dynamicProps (preferJsonParseFailureAsContentArray=false)", () => {
    const el = makeTestIdEl({
      testId: "my-btn",
      codegenNode: makeVNodeCall({
        patchFlag: 2,
        dynamicProps: expr("[bad json]"),
      }),
    });

    const meta = tryCreateElementMetadata({
      element: el,
      semanticNameMap,
      debug: false,
      debugPrefix: "[t]",
      preferJsonParseFailureAsContentArray: false,
    })!;

    expect(meta.dynamicProps).toEqual([]);
  });

  it("falls back to [content] for an unparseable JSON-array dynamicProps when preferJsonParseFailureAsContentArray=true", () => {
    const el = makeTestIdEl({
      testId: "my-btn",
      codegenNode: makeVNodeCall({
        patchFlag: 2,
        dynamicProps: expr("[bad json]"),
      }),
    });

    const meta = tryCreateElementMetadata({
      element: el,
      semanticNameMap,
      debug: false,
      debugPrefix: "[t]",
      preferJsonParseFailureAsContentArray: true,
    })!;

    expect(meta.dynamicProps).toEqual(["[bad json]"]);
  });

  it("normalizes a whitespace-only testIdAttribute to the default", () => {
    const el = makeTestIdEl({ testId: "my-btn", codegenNode: makeVNodeCall({}) });
    const meta = tryCreateElementMetadata({
      element: el,
      semanticNameMap,
      debug: false,
      debugPrefix: "[t]",
      preferJsonParseFailureAsContentArray: false,
      testIdAttribute: "   ",
    })!;
    expect(meta.testId).toBe("my-btn");
  });

  it("respects a custom testIdAttribute that is trimmed", () => {
    const el = makeTestIdEl({
      bindTestId: "qa-thing",
      codegenNode: makeVNodeCall({}),
    });
    // Replace the default data-testid directive arg name with the custom one.
    const testIdProp = el.props[0];
    if (testIdProp.type === NodeTypes.DIRECTIVE) {
      testIdProp.arg = expr("data-qa");
    }

    const meta = tryCreateElementMetadata({
      element: el,
      semanticNameMap,
      debug: false,
      debugPrefix: "[t]",
      preferJsonParseFailureAsContentArray: false,
      testIdAttribute: "  data-qa  ",
    })!;
    expect(meta.testId).toBe("qa-thing");
  });

  it("emits debug logs when debug is enabled", () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.join(" ")); };
    try {
      const el = makeTestIdEl({
        testId: "my-btn",
        codegenNode: makeVNodeCall({
          patchFlag: 2,
          dynamicProps: expr("class"),
        }),
      });

      const meta = tryCreateElementMetadata({
        element: el,
        semanticNameMap,
        debug: true,
        debugPrefix: "[t]",
        preferJsonParseFailureAsContentArray: false,
      })!;

      expect(meta).not.toBeNull();
      expect(logs.some((l) => l.includes("testId=\"my-btn\""))).toBe(true);
      expect(logs.some((l) => l.includes("patchFlag: 2"))).toBe(true);
      expect(logs.some((l) => l.includes("dynamicProps: class"))).toBe(true);
    }
    finally {
      console.log = originalLog;
    }
  });
});

describe("compiler-metadata-utils.ts branch coverage", () => {
  const semanticNameMap = new Map<string, string>();

  function makeTestIdEl(opts: {
    testId?: string;
    codegenNode?: ElementNode["codegenNode"];
    props?: Array<AttributeNode | DirectiveNode>;
    children?: ElementNode["children"];
    tag?: string;
  }): ElementNode {
    const props: Array<AttributeNode | DirectiveNode> = opts.props ?? [];
    if (opts.testId !== undefined) {
      props.unshift(makeAttributeNode("data-testid", opts.testId));
    }
    return makeElement({
      tag: opts.tag ?? "button",
      props,
      children: opts.children ?? [],
      codegenNode: opts.codegenNode,
    });
  }

  it("skips TEXT children that collapse to empty whitespace (line 106 false branch)", () => {
    const el = makeTestIdEl({
      testId: "my-btn",
      codegenNode: makeVNodeCall({}),
      children: [
        // A whitespace-only text node collapses to "" -> falsy -> not pushed.
        makeTextNode("   "),
        // A meaningful text node alongside it.
        makeTextNode("Hello"),
      ],
    });

    const meta = tryCreateElementMetadata({
      element: el,
      semanticNameMap,
      debug: false,
      debugPrefix: "[t]",
      preferJsonParseFailureAsContentArray: false,
    })!;

    // Only the non-empty text node contributes.
    expect(meta.staticTextContent).toBe("Hello");
  });

  it("ignores child nodes that are neither TEXT nor ELEMENT (line 112 false branch)", () => {
    const el = makeTestIdEl({
      testId: "my-btn",
      codegenNode: makeVNodeCall({}),
      children: [
        makeTextNode("Keep"),
        // An interpolation/comment node is neither TEXT nor ELEMENT -> ignored by visit.
        makeInterpolationNode(),
        makeCommentNode(),
      ],
    });

    const meta = tryCreateElementMetadata({
      element: el,
      semanticNameMap,
      debug: false,
      debugPrefix: "[t]",
      preferJsonParseFailureAsContentArray: false,
    })!;

    expect(meta.staticTextContent).toBe("Keep");
  });

  it("does not enter the JSON-array fallback branch for a non-array simple expression dynamicProps (line 159 false branch)", () => {
    const el = makeTestIdEl({
      testId: "my-btn",
      codegenNode: makeVNodeCall({
        patchFlag: 2,
        // A non-array simple expression: parseDynamicProps wraps it as ["class"],
        // and the fallback `if (content.startsWith("[")...)` is false.
        dynamicProps: expr("class"),
      }),
    });

    const meta = tryCreateElementMetadata({
      element: el,
      semanticNameMap,
      debug: false,
      debugPrefix: "[t]",
      preferJsonParseFailureAsContentArray: false,
    })!;

    expect(meta.dynamicProps).toEqual(["class"]);
  });

  it("logs 'none' for dynamicProps in debug mode when dynamicPropsList is empty (line 187 || none branch)", () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.join(" ")); };
    try {
      const el = makeTestIdEl({
        testId: "my-btn",
        codegenNode: makeVNodeCall({
          // An unparseable JSON-array expression with preferJsonParseFailureAsContentArray=false
          // yields dynamicPropsList = [] -> [].join() is "" -> logs "none".
          dynamicProps: expr("[bad json]"),
        }),
      });

      tryCreateElementMetadata({
        element: el,
        semanticNameMap,
        debug: true,
        debugPrefix: "[t]",
        preferJsonParseFailureAsContentArray: false,
      })!;

      expect(logs.some((l) => l.includes("dynamicProps: none"))).toBe(true);
    }
    finally {
      console.log = originalLog;
    }
  });
});
