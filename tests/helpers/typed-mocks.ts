// @vitest-environment node
//
// Typed factories for building complete, type-correct Vue compiler AST nodes and
// other test scaffolding WITHOUT `as any` casts. The repo enforces
// `@typescript-eslint/no-explicit-any: error` even in tests, so every object
// constructed here must structurally satisfy its declared type.
//
// For element-shaped nodes we parse a minimal real template with `baseParse`
// (which populates every required field — `loc`, `ns`, `nameLoc`, …) and then
// apply per-test overrides, rather than hand-enumerating the many required
// fields of the compiler's node interfaces.
import type { Plugin, PluginOption } from "vite";
import {
  type AttributeNode,
  type DirectiveNode,
  type ElementNode,
  type ExpressionNode,
  type SimpleExpressionNode,
  type SourceLocation,
  type TextNode,
  type TransformContext,
  type VNodeCall,
  baseParse,
  ConstantTypes,
  createTransformContext,
  NodeTypes,
} from "@vue/compiler-core";

function loc(): SourceLocation {
  return {
    start: { offset: 0, line: 1, column: 1 },
    end: { offset: 0, line: 1, column: 1 },
    source: "",
  };
}

/**
 * A complete `SimpleExpressionNode`. `isStatic` defaults to `true` (a literal
 * string); pass `false` for a dynamic binding expression.
 */
export function makeSimpleExpression(content: string, isStatic = true): SimpleExpressionNode {
  return {
    type: NodeTypes.SIMPLE_EXPRESSION,
    content,
    isStatic,
    constType: ConstantTypes.NOT_CONSTANT,
    loc: loc(),
  };
}

/** A complete `TextNode` (static text content). */
export function makeTextNode(content: string): TextNode {
  return { type: NodeTypes.TEXT, content, loc: loc() };
}

/** A complete `AttributeNode` (a static HTML attribute, optionally with a value). */
export function makeAttributeNode(name: string, value?: string): AttributeNode {
  return {
    type: NodeTypes.ATTRIBUTE,
    name,
    nameLoc: loc(),
    value: value === undefined ? undefined : makeTextNode(value),
    loc: loc(),
  };
}

/** A complete `DirectiveNode` (e.g. `:data-testid="…"`, `@click="…"`). */
export function makeDirectiveNode(
  name: string,
  opts: { exp?: ExpressionNode; arg?: ExpressionNode; modifiers?: SimpleExpressionNode[] } = {},
): DirectiveNode {
  return {
    type: NodeTypes.DIRECTIVE,
    name,
    exp: opts.exp,
    arg: opts.arg,
    modifiers: opts.modifiers ?? [],
    loc: loc(),
  };
}

/**
 * A complete `VNodeCall` with neutral defaults. Override `patchFlag`,
 * `dynamicProps`, `tag`, etc. per test. Used as an element's `codegenNode`.
 */
export function makeVNodeCall(overrides: Partial<VNodeCall> = {}): VNodeCall {
  return {
    type: NodeTypes.VNODE_CALL,
    tag: "div",
    props: undefined,
    children: undefined,
    patchFlag: undefined,
    dynamicProps: undefined,
    directives: undefined,
    isBlock: false,
    disableTracking: false,
    isComponent: false,
    loc: loc(),
    ...overrides,
  };
}

/**
 * A complete `ElementNode` parsed from a minimal real template (so every
 * required field — `loc`, `ns`, `tagType`, `codegenNode`, … — is populated),
 * with `overrides` applied on top. Commonly overridden: `tag`, `props`,
 * `children`, and `codegenNode` (via {@link makeVNodeCall}).
 */
export function makeElementNode(overrides: Partial<ElementNode> = {}): ElementNode {
  const root = baseParse("<div />");
  const child = root.children[0];
  if (!child || child.type !== NodeTypes.ELEMENT) {
    throw new Error("[typed-mocks] expected a parsed element node");
  }
  // The parsed `<div/>` child is a complete `ElementNode`; overrides layer on
  // top. `as ElementNode` is a narrowing assertion to the known concrete type
  // (not `as any`) — the spread of a union member widens, so we re-assert.
  return {
    ...child,
    ...overrides,
  } as ElementNode;
}

/**
 * A real `TransformContext` (via `createTransformContext` + `baseParse`).
 * Replaces `transform(node, {} as any)` — the second argument to a `NodeTransform`
 * is a `TransformContext`, and constructing a real one avoids any cast.
 */
export function makeTransformContext(): TransformContext {
  return createTransformContext(baseParse("<root />"), {});
}

/**
 * Narrow a `PluginOption` (which may be an array, `false`, `null`, or
 * `undefined`) to a single `Plugin` via a runtime check — no type assertion.
 * Throws if the option is not exactly one plugin, which surfaces test setup
 * mistakes loudly instead of silently mocking against the wrong shape.
 */
export function asSinglePlugin(plugin: PluginOption): Plugin {
  if (Array.isArray(plugin) || !plugin || plugin instanceof Promise) {
    throw new Error("[typed-mocks] expected a single Vite Plugin, got an array, promise, or falsy option");
  }
  return plugin;
}

/**
 * Unwrap a Vite `ObjectHook<T>` to its bare, callable function. Vite types each
 * plugin hook as `ObjectHook<T> = T | { handler: T; order?: ... }` (and a
 * filter-augmented variant for some hooks); only the bare-function form is
 * callable, so callers must normalize before invoking. This performs the
 * runtime `function` vs `{ handler }` check and returns the function with its
 * `this` parameter stripped (`OmitThisParameter`) so it can be called bare —
 * the test doubles under test capture their dependencies via closure and never
 * read `this`. Returns `undefined` for an absent hook, so `?.()` chains keep
 * working.
 */
export function hookFn<H extends (...args: never[]) => void>(
  hook: H | { handler: H; order?: "pre" | "post" | null } | undefined | null,
): OmitThisParameter<H> | undefined {
  if (hook == null) {
    return undefined;
  }
  const fn = typeof hook === "function" ? hook : hook.handler;
  return fn as OmitThisParameter<H>;
}
