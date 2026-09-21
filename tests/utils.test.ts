// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { ElementNode } from "@vue/compiler-core";
import { parse } from "@vue/compiler-dom";

import {
  __internal,
  collapseWhitespace,
  getSlotScopeVariablesUsedAsBareCallbackHandlers,
  toPascalCase,
} from "../utils";

function parseSlotTemplate(source: string): ElementNode {
  const root = parse(source);
  const component = root.children[0] as ElementNode;
  return component.children[0] as ElementNode;
}

describe("utils", () => {
  it("toPascalCase converts separators into PascalCase", () => {
    expect(toPascalCase("hello world")).toBe("HelloWorld");
    expect(toPascalCase("hello-world")).toBe("HelloWorld");
    expect(toPascalCase("hello_world")).toBe("HelloWorld");
    expect(toPascalCase("user.profile.name")).toBe("UserProfileName");
  });

  it("collapseWhitespace collapses whitespace runs and trims ends", () => {
    expect(collapseWhitespace("  foo   bar\n\tbaz  ")).toBe("foo bar baz");
    expect(collapseWhitespace("\n\n")).toBe("");
    expect(collapseWhitespace("already clean")).toBe("already clean");
    expect(collapseWhitespace(" leading")).toBe("leading");
  });

  it("toPascalCase strips interpolation remnants", () => {
    expect(toPascalCase("text_${id}_more")).toBe("TextMore");
  });

  it("isSimpleScopeIdentifier uses the AST to distinguish bare identifiers from expressions", () => {
    expect(__internal.isSimpleScopeIdentifier("data")).toBe(true);
    expect(__internal.isSimpleScopeIdentifier("$slot")).toBe(true);
    expect(__internal.isSimpleScopeIdentifier("data.key")).toBe(false);
    expect(__internal.isSimpleScopeIdentifier("{ data }")).toBe(false);
    expect(__internal.isSimpleScopeIdentifier("data ?? fallback")).toBe(false);
  });

  it("splitNullishCoalescingExpression flattens top-level nullish chains with AST source slices", () => {
    expect(__internal.splitNullishCoalescingExpression("data.key ?? getKey(data) ?? data")).toEqual([
      "data.key",
      "getKey(data)",
      "data",
    ]);
  });

  it("getDegenerateSlotScopeFallbackKeyVariable detects the bare-variable-terminal chain", () => {
    // The generated fallback chain: terminal operand is the bare slot-scope variable.
    expect(
      __internal.getDegenerateSlotScopeFallbackKeyVariable(
        "cancel.key ?? cancel.data?.id ?? cancel.id ?? cancel.value ?? cancel.url ?? cancel",
      ),
    ).toBe("cancel");

    // Renaming the destructured prop renames the chain but stays degenerate.
    expect(
      __internal.getDegenerateSlotScopeFallbackKeyVariable(
        "cancelAction.key ?? cancelAction.data?.id ?? cancelAction.id ?? cancelAction.value ?? cancelAction.url ?? cancelAction",
      ),
    ).toBe("cancelAction");
  });

  it("getDegenerateSlotScopeFallbackKeyVariable rejects meaningful chains and non-chains", () => {
    // Hand-written chain without the bare-variable terminal is meaningful row data.
    expect(__internal.getDegenerateSlotScopeFallbackKeyVariable("item.key ?? item.data?.id")).toBeNull();
    // Terminal doesn't match the member base.
    expect(__internal.getDegenerateSlotScopeFallbackKeyVariable("item.key ?? other")).toBeNull();
    // A call operand is not a member chain.
    expect(__internal.getDegenerateSlotScopeFallbackKeyVariable("item.key ?? getKey(item) ?? item")).toBeNull();
    // Not a nullish chain at all.
    expect(__internal.getDegenerateSlotScopeFallbackKeyVariable("item.id")).toBeNull();
    expect(__internal.getDegenerateSlotScopeFallbackKeyVariable(null)).toBeNull();
    expect(__internal.getDegenerateSlotScopeFallbackKeyVariable("")).toBeNull();
  });

  it("uses Vue's parsed v-for value, key, and index aliases when tracking shadowed callbacks", () => {
    const template = parseSlotTemplate(`
      <MyList>
        <template #row="{ item, key, index, outer }">
          <div v-for="(item, key, index) in rows">
            <button @click="item">Item</button>
            <button @click="key">Key</button>
            <button @click="index">Index</button>
          </div>
          <button @click="outer">Outer</button>
        </template>
      </MyList>
    `);

    expect(getSlotScopeVariablesUsedAsBareCallbackHandlers(template)).toEqual(["outer"]);
  });

  it("tracks nested, defaulted, renamed, and rest bindings in a v-for object pattern", () => {
    const template = parseSlotTemplate(`
      <MyList>
        <template #row="{ item, handler, rest, key, index, outer }">
          <div v-for="({ action: item, nested: { handler = fallback }, ...rest }, key, index) in rows">
            <button @click="item">Item</button>
            <button @click="handler">Handler</button>
            <button @click="rest">Rest</button>
            <button @click="key">Key</button>
            <button @click="index">Index</button>
          </div>
          <button @click="outer">Outer</button>
        </template>
      </MyList>
    `);

    expect(getSlotScopeVariablesUsedAsBareCallbackHandlers(template)).toEqual(["outer"]);
  });

  it("tracks defaulted and rest bindings in a v-for array pattern using of", () => {
    const template = parseSlotTemplate(`
      <MyList>
        <template #row="{ item, handler, rest, index, outer }">
          <div v-for="([item, , handler = fallback, ...rest], index) of rows">
            <button @click="item">Item</button>
            <button @click="handler">Handler</button>
            <button @click="rest">Rest</button>
            <button @click="index">Index</button>
          </div>
          <button @click="outer">Outer</button>
        </template>
      </MyList>
    `);

    expect(getSlotScopeVariablesUsedAsBareCallbackHandlers(template)).toEqual(["outer"]);
  });
});
