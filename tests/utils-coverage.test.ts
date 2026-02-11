// @vitest-environment node
import { describe, expect, it } from "vitest";

import type {
  ElementNode,
  ForNode,
  RootNode,
  TemplateChildNode,
} from "@vue/compiler-core";
import { ConstantTypes, NodeTypes } from "@vue/compiler-core";
import type { CompilerOptions } from "@vue/compiler-dom";
import { baseCompile, parse, parserOptions } from "@vue/compiler-dom";
import { extend } from "@vue/shared";

import { parseExpression } from "@babel/parser";

import {
  addComponentTestIds,
  applyResolvedDataTestId,
  findDataTestIdAttribute,
  findTestIdAttribute,
  formatTagName,
  generateToDirectiveDataTestId,
  getAttributeValueText,
  getComposedClickHandlerContent,
  getContainedInVForDirectiveKeyValue,
  getIdOrName,
  getKeyDirectiveValue,
  getNativeWrapperTransformInfo,
  getRouteNameKeyFromToDirective,
  getSelfClosingForDirectiveKeyAttrValue,
  getInnerText,
  isNodeContainedInTemplateWithData,
  isSimpleExpressionNode,
  nodeHandlerAttributeInfo,
  nodeHandlerAttributeValue,
  nodeHasClickDirective,
  nodeHasToDirective,
  setResolveToComponentNameFn,
  setRouteNameToComponentNameMap,
  staticAttributeValue,
  templateAttributeValue,
  toPascalCase,
  tryGetClickDirective,
  tryGetContainedInStaticVForSourceLiteralValues,
  tryGetExistingElementDataTestId,
  tryResolveToDirectiveTargetComponentName,
  upsertAttribute,
  upperFirst,
} from "../utils";

import type { IComponentDependencies, IDataTestId, HierarchyMap, NativeWrappersMap } from "../utils";

function parseTemplate(template: string, filename = "/src/components/Test.vue"): RootNode {
  return parse(template, extend({}, parserOptions, { filename }));
}

function compileAndCaptureAst(source: string, options: CompilerOptions & { filename: string }): RootNode {
  let captured: RootNode | null = null;

  baseCompile(
    source,
    extend({}, parserOptions, options, {
      prefixIdentifiers: true,
      nodeTransforms: [
        ...(options.nodeTransforms || []),
        (node: RootNode | TemplateChildNode) => {
          if (node.type === NodeTypes.ROOT) {
            return () => {
              captured = node as RootNode;
            };
          }
        },
      ],
    }),
  );

  if (!captured) {
    throw new Error("Failed to capture compiler AST");
  }

  return captured;
}

function firstElement(root: RootNode): ElementNode {
  const visit = (node: TemplateChildNode | RootNode): ElementNode | null => {
    if (node.type === NodeTypes.ELEMENT) {
      return node as ElementNode;
    }

    if (node.type === NodeTypes.ROOT) {
      for (const c of (node as RootNode).children) {
        const found = visit(c as any);
        if (found) return found;
      }
    }
    expect(toPascalCase("hello world")).toBe("HelloWorld");
    expect(isSimpleExpressionNode(null)).toBe(false);
    expect(isSimpleExpressionNode({})).toBe(false);
    expect(isSimpleExpressionNode({ type: NodeTypes.SIMPLE_EXPRESSION } as any)).toBe(true);

    return null;
  };

  const found = visit(root);
  if (!found) {
    throw new Error("No element node found in template");
  }
  return found;
}

function findFirstForNode(root: RootNode): ForNode {
  let found: ForNode | null = null;

  const visitAny = (node: any) => {
    if (!node || found) return;

    if (node.type === NodeTypes.FOR) {
      found = node as ForNode;
      return;
    }

    if (node.type === NodeTypes.ROOT) {
      for (const c of (node as RootNode).children ?? []) visitAny(c);
      return;
    }

    if (node.type === NodeTypes.ELEMENT) {
      for (const c of node.children ?? []) visitAny(c);
      return;
    }

    if (node.type === NodeTypes.IF) {
      for (const b of node.branches ?? []) visitAny(b);
      return;
    }

    if (node.type === NodeTypes.IF_BRANCH) {
      for (const c of node.children ?? []) visitAny(c);
    }
  };

  visitAny(root);
  if (!found) {
    throw new Error("No ForNode found");
  }
  return found;
}

function findFirstTag(root: RootNode, tag: string): ElementNode {
  let found: ElementNode | null = null;

  const visitAny = (node: any) => {
    if (!node || found) return;

    if (node.type === NodeTypes.ELEMENT) {
      if ((node as ElementNode).tag === tag) {
        found = node as ElementNode;
        return;
      }
      for (const c of (node as ElementNode).children ?? []) visitAny(c);
      return;
    }

    if (node.type === NodeTypes.ROOT) {
      for (const c of (node as RootNode).children ?? []) visitAny(c);
      return;
    }

    if (node.type === NodeTypes.FOR || node.type === NodeTypes.IF_BRANCH) {
      for (const c of (node.children ?? [])) visitAny(c);
      return;
    }

    if (node.type === NodeTypes.IF) {
      for (const b of (node.branches ?? [])) visitAny(b);
    }
  };

  visitAny(root);
  if (!found) {
    throw new Error(`No <${tag}> found`);
  }
  return found;
}

function buildHierarchyMap(root: RootNode): HierarchyMap {
  const map: HierarchyMap = new Map();

  const visit = (node: any, parent: ElementNode | null) => {
    if (!node) return;

    if (node.type === NodeTypes.ELEMENT) {
      const el = node as ElementNode;
      if (parent) {
        map.set(el, parent);
      }
      for (const c of el.children ?? []) visit(c, el);
      return;
    }

    if (node.type === NodeTypes.ROOT) {
      for (const c of (node as RootNode).children ?? []) visit(c, null);
      return;
    }

    if (node.type === NodeTypes.FOR || node.type === NodeTypes.IF_BRANCH) {
      for (const c of (node.children ?? [])) visit(c, parent);
      return;
    }

    if (node.type === NodeTypes.IF) {
      for (const b of (node.branches ?? [])) visit(b, parent);
    }
  };

  visit(root, null);
  return map;
}

function setBindAst(node: ElementNode, argName: string, expAstSource: string) {
  const dir = node.props.find(
    (p): p is any =>
      p.type === NodeTypes.DIRECTIVE
      && p.name === "bind"
      && p.arg?.type === NodeTypes.SIMPLE_EXPRESSION
      && p.arg.content === argName,
  );
  if (!dir || !dir.exp || dir.exp.type !== NodeTypes.SIMPLE_EXPRESSION) {
    throw new Error(`Missing :${argName} directive with SIMPLE_EXPRESSION`);
  }
  (dir.exp as any).ast = parseExpression(expAstSource, { plugins: ["typescript"] });
}

describe("utils.ts coverage", () => {
  it("covers simple type helpers and click detection", () => {
    expect(toPascalCase("hello world")).toBe("HelloWorld");

    expect(upperFirst("")).toBe("");
    expect(upperFirst("hello")).toBe("Hello");

    expect(isSimpleExpressionNode(null)).toBe(false);
    expect(isSimpleExpressionNode({})).toBe(false);
    expect(isSimpleExpressionNode({ type: NodeTypes.SIMPLE_EXPRESSION } as any)).toBe(true);

    const ast = parseTemplate("<button @click=\"save()\">Save</button>");
    const btn = firstElement(ast);
    expect(nodeHasClickDirective(btn)).toBe(true);
    expect(tryGetClickDirective(btn)).toBeTruthy();
  });

  it("resolves router-link targets via resolve fn and fallback map", () => {
    const ast = parseTemplate("<RouterLink :to=\"{ name: 'users' }\">Users</RouterLink>");
    const el = firstElement(ast);
    const toDir = nodeHasToDirective(el);
    expect(toDir).toBeTruthy();

    // Fallback map path
    setResolveToComponentNameFn(null);
    setRouteNameToComponentNameMap(new Map([["Users", "UsersPage"]]));
    expect(getRouteNameKeyFromToDirective(toDir!)).toBe("Users");
    expect(tryResolveToDirectiveTargetComponentName(toDir!)).toBe("UsersPage");

    // resolveToComponentName path (also exercises object `params` placeholder building)
    setRouteNameToComponentNameMap(null);
    setResolveToComponentNameFn((to) => {
      if (typeof to === "string") return null;
      const keys = Object.keys((to as any).params ?? {}).sort();
      expect(keys).toEqual(["id"]);
      expect((to as any).params.id).toBe("__placeholder__");
      return "UsersViaResolve";
    });

    const ast2 = parseTemplate("<RouterLink :to=\"{ name: 'users', params: { id: foo } }\">Users</RouterLink>");
    const el2 = firstElement(ast2);
    const toDir2 = nodeHasToDirective(el2);
    expect(tryResolveToDirectiveTargetComponentName(toDir2!)).toBe("UsersViaResolve");
  });

  it("derives :handler semanticNameHint from literal call arguments", () => {
    const root = parseTemplate(`
      <LoadButton :handler="() => createTenants('selected')">Selected</LoadButton>
    `);
    const el = firstElement(root);

    const info = nodeHandlerAttributeInfo(el);
    expect(info).toBeTruthy();
    expect(info?.semanticNameHint).toBe("CreateTenantsSelected");

    const root2 = parseTemplate(`
      <LoadButton :handler="() => createTenants('all')">All</LoadButton>
    `);
    const el2 = firstElement(root2);

    const info2 = nodeHandlerAttributeInfo(el2);
    expect(info2).toBeTruthy();
    expect(info2?.semanticNameHint).toBe("CreateTenantsAll");
  });

  it("derives :handler semanticNameHint from member-expression arguments", () => {
    const root = parseTemplate(`
      <LoadButton :handler="() => resolveConflictWithDecision(AgentIdentificationManualResolutionDecision.OverwriteExisting)">
        Overwrite
      </LoadButton>
    `);
    const el = firstElement(root);

    const info = nodeHandlerAttributeInfo(el);
    expect(info).toBeTruthy();
    expect(info?.semanticNameHint).toBe("ResolveConflictWithDecisionOverwriteExisting");

    const root2 = parseTemplate(`
      <LoadButton :handler="() => resolveConflictWithDecision(AgentIdentificationManualResolutionDecision.GenerateNewDeviceId)">
        Generate
      </LoadButton>
    `);
    const el2 = firstElement(root2);

    const info2 = nodeHandlerAttributeInfo(el2);
    expect(info2).toBeTruthy();
    expect(info2?.semanticNameHint).toBe("ResolveConflictWithDecisionGenerateNewDeviceId");
  });

  it("derives :handler semanticNameHint from assignment-bodied arrow functions", () => {
    const root = parseTemplate(`
      <LoadButton :handler="() => showResetLocalDatabaseModal = true">Reset</LoadButton>
    `);
    const el = firstElement(root);
    const info = nodeHandlerAttributeInfo(el);
    expect(info).toBeTruthy();
    expect(info?.semanticNameHint).toBe("SetShowResetLocalDatabaseModalTrue");

    const root2 = parseTemplate(`
      <LoadButton :handler="() => showPopulateScenarioModal = true">Populate</LoadButton>
    `);
    const el2 = firstElement(root2);
    const info2 = nodeHandlerAttributeInfo(el2);
    expect(info2).toBeTruthy();
    expect(info2?.semanticNameHint).toBe("SetShowPopulateScenarioModalTrue");
  });

  it("derives assignment target name from ref.value", () => {
    const root = parseTemplate(`
      <LoadButton :handler="() => showModal.value = true">Show</LoadButton>
    `);
    const el = firstElement(root);
    const info = nodeHandlerAttributeInfo(el);
    expect(info).toBeTruthy();
    expect(info?.semanticNameHint).toBe("SetShowModalTrue");
  });

  it("handles :key extraction paths", () => {
    const ast = parseTemplate("<div :key=\"item.id\" />");
    const el = firstElement(ast);
    expect(getKeyDirectiveValue(el)).toBe("${item.id}");
    // any non-null context triggers stringifyExpression branch
    expect(getKeyDirectiveValue(el, {} as any)).toBe("${item.id}");

    const ast2 = parseTemplate("<Foo v-for=\"x in xs\" :key=\"x.id\" />");
    const foo = firstElement(ast2);
    expect(foo.isSelfClosing).toBe(true);
    expect(getSelfClosingForDirectiveKeyAttrValue(foo)).toBe("${x.id}");

    const ast3 = parseTemplate("<Foo :key=\"x.id\"></Foo>");
    const foo2 = firstElement(ast3);
    expect(Boolean(foo2.isSelfClosing)).toBe(false);
    expect(getSelfClosingForDirectiveKeyAttrValue(foo2)).toBeNull();
  });

  it("extracts id/name identifiers", () => {
    expect(getIdOrName(firstElement(parseTemplate("<div id=\"foo-bar\" />")))).toBe("FooBar");
    expect(getIdOrName(firstElement(parseTemplate("<div name=\"foo_bar\" />")))).toBe("FooBar");
    const dyn = firstElement(parseTemplate("<div :id=\"something\" />"));
    expect(getIdOrName(dyn)).toContain("someUniqueValueToDifferentiateInstanceFromOthersOnPageUsuallyAnId");
  });

  it("extracts :handler semantic hints from common patterns", () => {
    const direct = firstElement(parseTemplate("<LoadButton :handler=\"approveChangeRequest\" />"));
    expect(nodeHandlerAttributeValue(direct)).toBe("ApproveChangeRequest");
    expect(nodeHandlerAttributeInfo(direct)?.mergeKey).toBe("handler:expr:approveChangeRequest");

    const goBackFalse = firstElement(parseTemplate("<LoadButton :handler=\"() => onSubmit({goBack:false})\" />"));
    const goBackTrue = firstElement(parseTemplate("<LoadButton :handler=\"() => onSubmit({goBack:true})\" />"));
    expect(nodeHandlerAttributeValue(goBackFalse)).toBe("OnSubmitGoBackFalse");
    expect(nodeHandlerAttributeValue(goBackTrue)).toBe("OnSubmitGoBackTrue");
    expect(nodeHandlerAttributeInfo(goBackFalse)?.mergeKey).toBe("handler:expr:() => onSubmit({goBack:false})");
    expect(nodeHandlerAttributeInfo(goBackTrue)?.mergeKey).toBe("handler:expr:() => onSubmit({goBack:true})");

    const other = firstElement(parseTemplate("<LoadButton :handler=\"() => onDuplicateAssignment(assignmentId, props.databaseType)\" />"));
    expect(nodeHandlerAttributeValue(other)).toBe("OnDuplicateAssignment");
  });

  it("detects containment within <template v-slot> scope", () => {
    const withData = parseTemplate("<MyList><template #item=\"{ data }\"><div><span>Hi</span></div></template></MyList>");
    const map = buildHierarchyMap(withData);
    const span = findFirstTag(withData, "span");
    expect(isNodeContainedInTemplateWithData(span, map)).toBe(true);

    const withoutData = parseTemplate("<MyList><template><div><span>Hi</span></div></template></MyList>");
    const map2 = buildHierarchyMap(withoutData);
    const span2 = findFirstTag(withoutData, "span");
    expect(isNodeContainedInTemplateWithData(span2, map2)).toBe(false);
  });

  it("walks v-for scopes for :key and infers static iterable literals", () => {
    const ast = parseTemplate("<div v-for=\"item in items\" :key=\"item.id\"><span /></div>");
    const span = findFirstTag(ast, "span");
    const map = buildHierarchyMap(ast);

    expect(getContainedInVForDirectiveKeyValue({ scopes: { vFor: 0 } } as any, span, map)).toBeNull();
    expect(getContainedInVForDirectiveKeyValue({ scopes: { vFor: 1 } } as any, span, map)).toBe("${item.id}");

    const astStatic = compileAndCaptureAst(
      "<div v-for=\"item in ['One','Two']\" :key=\"item\"><span /></div>",
      { filename: "/src/components/Test.vue" },
    );
    const forNode = findFirstForNode(astStatic);

    const ctx = { scopes: { vFor: 1 }, parent: forNode } as any;
    const values = tryGetContainedInStaticVForSourceLiteralValues(ctx, {} as any, buildHierarchyMap(astStatic));
    expect(values).toEqual(["One", "Two"]);

    const astStaticTpl = compileAndCaptureAst(
      "<div v-for=\"item in [`One`, `Two`]\" :key=\"item\"><span /></div>",
      { filename: "/src/components/Test.vue" },
    );
    const forNodeTpl = findFirstForNode(astStaticTpl);
    const ctxTpl = { scopes: { vFor: 1 }, parent: forNodeTpl } as any;
    const valuesTpl = tryGetContainedInStaticVForSourceLiteralValues(ctxTpl, {} as any, buildHierarchyMap(astStaticTpl));
    expect(valuesTpl).toEqual(["One", "Two"]);

    // Branches: NOT_CONSTANT => null
    const fakeSimple = { type: NodeTypes.SIMPLE_EXPRESSION, constType: ConstantTypes.NOT_CONSTANT } as any;
    const fakeFor = { type: NodeTypes.FOR, source: fakeSimple } as any;
    expect(tryGetContainedInStaticVForSourceLiteralValues({ scopes: { vFor: 1 }, parent: fakeFor } as any, {} as any, buildHierarchyMap(astStatic))).toBeNull();
  });

  it("extracts handler names from :handler bindings", () => {
    expect(nodeHandlerAttributeValue(firstElement(parseTemplate("<Foo :handler=\"myHandler\" />")))).toBe("MyHandler");
    expect(nodeHandlerAttributeValue(firstElement(parseTemplate("<Foo :handler=\"obj.myHandler\" />")))).toBe("MyHandler");
    expect(nodeHandlerAttributeValue(firstElement(parseTemplate("<Foo :handler=\"obj['my-handler']\" />")))).toBe("MyHandler");
    expect(nodeHandlerAttributeValue(firstElement(parseTemplate("<Foo :handler=\"(x) => myHandler(x)\" />")))).toBe("MyHandler");
    expect(nodeHandlerAttributeValue(firstElement(parseTemplate("<Foo handler=\"nope\" />")))).toBeNull();
  });

  it("adds component test ids into a per-component set", () => {
    const map = new Map<string, Set<string>>();
    addComponentTestIds("MyComp", map, "a");
    addComponentTestIds("MyComp", map, "a");
    addComponentTestIds("MyComp", map, "b");
    expect(Array.from(map.get("MyComp") ?? []).sort()).toEqual(["a", "b"]);
  });

  it("computes native wrapper transform info (valueAttribute, v-model, and option prefixes)", () => {
    const wrappers: NativeWrappersMap = {
      "v-select": { role: "vselect", requiresOptionDataTestIdPrefix: true },
      "dx-radio-group": { role: "radio", valueAttribute: "value" },
    };

    // valueAttribute static
    const radio = firstElement(parseTemplate("<dx-radio-group value=\"A\" />"));
    const info1 = getNativeWrapperTransformInfo(radio, "Comp", wrappers);
    expect(getAttributeValueText(info1.nativeWrappersValue!)).toBe("Comp-A-radio");

    // v-model + option prefix
    const sel = firstElement(parseTemplate("<v-select v-model=\"selectedGroup\" />"));
    const info2 = getNativeWrapperTransformInfo(sel, "Comp", wrappers);
    expect(getAttributeValueText(info2.nativeWrappersValue!)).toBe("Comp-SelectedGroup-vselect");
    expect(getAttributeValueText(info2.optionDataTestIdPrefixValue!)).toBe("Comp-SelectedGroup");
  });

  it("covers valueAttribute dynamic MemberExpression and CallExpression paths", () => {
    const wrappers: NativeWrappersMap = {
      "dx-radio-group": { role: "radio", valueAttribute: "value" },
    };

    const member = firstElement(parseTemplate("<dx-radio-group :value=\"obj.val\" />"));
    setBindAst(member, "value", "obj.val");
    const info1 = getNativeWrapperTransformInfo(member, "Comp", wrappers);
    expect(getAttributeValueText(info1.nativeWrappersValue!)).toBe("Comp-objval-radio");

    const call = firstElement(parseTemplate("<dx-radio-group :value=\"getVal()\" />"));
    setBindAst(call, "value", "getVal()\n");
    const info2 = getNativeWrapperTransformInfo(call, "Comp", wrappers);
    expect(info2.nativeWrappersValue!.kind).toBe("template");
    expect(getAttributeValueText(info2.nativeWrappersValue!)).toContain("getVal()");
  });

  it("prefers click-derived naming for button-like wrappers with @click", () => {
    const wrappers: NativeWrappersMap = {
      "my-button": { role: "button" },
    };
    const node = firstElement(parseTemplate("<my-button @click=\"doThing()\" />"));
    const info = getNativeWrapperTransformInfo(node, "Comp", wrappers);
    expect(info.nativeWrappersValue).toBeNull();
    expect(info.optionDataTestIdPrefixValue).toBeNull();
  });

  it("covers :modelValue AST parsing via getNativeWrapperTransformInfo", () => {
    const wrappers: NativeWrappersMap = { "v-select": { role: "vselect" } };

    const member = firstElement(parseTemplate("<v-select :modelValue=\"obj.myVal\" />"));
    setBindAst(member, "modelValue", "obj.myVal");
    expect(getAttributeValueText(getNativeWrapperTransformInfo(member, "Comp", wrappers).nativeWrappersValue!)).toBe("Comp-myVal-vselect");

    const call = firstElement(parseTemplate("<v-select :modelValue=\"getValue()\" />"));
    setBindAst(call, "modelValue", "getValue()\n");
    expect(getAttributeValueText(getNativeWrapperTransformInfo(call, "Comp", wrappers).nativeWrappersValue!)).toBe("Comp-getValue-vselect");

    const assign = firstElement(parseTemplate("<v-select :modelValue=\"model.value = suggested\" />"));
    setBindAst(assign, "modelValue", "model.value = suggested");
    expect(getAttributeValueText(getNativeWrapperTransformInfo(assign, "Comp", wrappers).nativeWrappersValue!)).toBe("Comp-value-vselect");

    const computed = firstElement(parseTemplate("<v-select :modelValue=\"obj['x']\" />"));
    setBindAst(computed, "modelValue", "obj['x']");
    expect(getNativeWrapperTransformInfo(computed, "Comp", wrappers).nativeWrappersValue).toBeNull();
  });

  it("generates :to data-testid values across primary shapes", () => {
    const wrappers: NativeWrappersMap = {};

    // object literal name + inner text
    const ast = parseTemplate("<RouterLink :to=\"{ name: 'Users' }\">Go</RouterLink>");
    const el = firstElement(ast);
    const toDir = nodeHasToDirective(el)!;
    const id1 = generateToDirectiveDataTestId("MyComp", el, toDir, { scopes: { vFor: 0 } } as any, new Map() as any, wrappers);
    expect(getAttributeValueText(id1!)).toBe("MyComp-Users-Go-routerlink");

    // string expression (no static name)
    const ast2 = parseTemplate("<RouterLink :to=\"toVar\">Go</RouterLink>");
    const el2 = firstElement(ast2);
    const toDir2 = nodeHasToDirective(el2)!;
    const id2 = generateToDirectiveDataTestId("MyComp", el2, toDir2, { scopes: { vFor: 0 } } as any, new Map() as any, wrappers);
    expect(id2!.kind).toBe("template");
    expect(getAttributeValueText(id2!)).toContain("toVar");

    // key-driven path
    const ast3 = parseTemplate("<RouterLink v-for=\"item in items\" :key=\"item.id\" :to=\"{ name: 'Users' }\">Go</RouterLink>");
    const el3 = firstElement(ast3);
    const toDir3 = nodeHasToDirective(el3)!;
    const id3 = generateToDirectiveDataTestId("MyComp", el3, toDir3, { scopes: { vFor: 1 } } as any, buildHierarchyMap(ast3), wrappers);
    expect(id3!.kind).toBe("template");
    expect(getAttributeValueText(id3!)).toContain("item.id");

    // formatTagName fallback
    expect(formatTagName(el3, wrappers)).toBe("-routerlink");
  });

  it("extracts and sanitizes inner text", () => {
    const node = firstElement(parseTemplate("<button>Save (now)!</button>"));
    expect(getInnerText(node)).toBe("Save-");
  });

  it("finds and upserts attributes (static and template)", () => {
    const ast = parseTemplate("<button data-testid=\"a\" :data-qa=\"`b`\" />");
    const el = firstElement(ast);

    expect(findTestIdAttribute(el, "data-testid")?.type).toBe(NodeTypes.ATTRIBUTE);
    expect(findTestIdAttribute(el, "data-qa")?.type).toBe(NodeTypes.DIRECTIVE);
    expect(findDataTestIdAttribute(el)?.type).toBe(NodeTypes.ATTRIBUTE);

    upsertAttribute(el, "data-testid", staticAttributeValue("x"));
    expect(findTestIdAttribute(el, "data-testid")?.type).toBe(NodeTypes.ATTRIBUTE);
    upsertAttribute(el, "data-testid", templateAttributeValue("Comp-${key}-x"));
    expect(findTestIdAttribute(el, "data-testid")?.type).toBe(NodeTypes.DIRECTIVE);
  });

  it("reads existing element test id attributes (static and bound)", () => {
    const staticEl = firstElement(parseTemplate("<div data-testid=\"abc\" />"));
    const info = tryGetExistingElementDataTestId(staticEl);
    expect(info?.value).toBe("abc");

    const dynEl = firstElement(parseTemplate("<div :data-testid=\"`abc-${id}`\" />"));
    const info2 = tryGetExistingElementDataTestId(dynEl);
    expect(info2?.isDynamic).toBe(true);
    expect(info2?.isStaticLiteral).toBe(false);
    expect(info2?.value).toContain("abc");
  });

  it("covers tryGetExistingElementDataTestId AST-based TemplateLiteral and StringLiteral paths", () => {
    const node = firstElement(parseTemplate("<div :data-testid=\"`abc-${id}`\" />"));
    setBindAst(node, "data-testid", "`abc-${id}`");
    const info = tryGetExistingElementDataTestId(node);
    expect(info?.isDynamic).toBe(true);
    expect(info?.isStaticLiteral).toBe(false);
    expect(info?.value).toBe("abc-${id}");

    const node2 = firstElement(parseTemplate("<div :data-testid=\"'foo'\" />"));
    setBindAst(node2, "data-testid", "'foo'");
    const info2 = tryGetExistingElementDataTestId(node2);
    expect(info2?.isDynamic).toBe(false);
    expect(info2?.isStaticLiteral).toBe(true);
    expect(info2?.value).toBe("foo");
  });

  it("throws when preserving an existing dynamic data-testid expression (unusable selector)", () => {
    const el = firstElement(parseTemplate("<button :data-testid=\"__props.name\" />"));

    const deps: IComponentDependencies = {
      filePath: "/src/components/MyComp.vue",
      childrenComponentSet: new Set(),
      usedComponentSet: new Set(),
      dataTestIdSet: new Set<IDataTestId>(),
      generatedMethods: new Map(),
      isView: false,
    };

    const generatedMethodContentByComponent = new Map<string, Set<string>>();

    expect(() => {
      applyResolvedDataTestId({
        element: el,
        componentName: "MyComp",
        parentComponentName: "MyComp",
        dependencies: deps,
        generatedMethodContentByComponent,
        nativeRole: "button",
        preferredGeneratedValue: staticAttributeValue("MyComp-Foo-button"),
        bestKeyPlaceholder: null,
        testIdAttribute: "data-testid",
        existingIdBehavior: "preserve",
        addHtmlAttribute: false,
      });
    }).toThrow(/cannot be preserved|dynamic/i);
  });

  it("allows preserving an existing key-based template literal data-testid", () => {
    const el = firstElement(parseTemplate("<button :data-testid=\"`abc-${item.id}`\" />"));
    setBindAst(el, "data-testid", "`abc-${item.id}`");

    const deps: IComponentDependencies = {
      filePath: "/src/components/MyComp.vue",
      childrenComponentSet: new Set(),
      usedComponentSet: new Set(),
      dataTestIdSet: new Set<IDataTestId>(),
      generatedMethods: new Map(),
      isView: false,
    };

    const generatedMethodContentByComponent = new Map<string, Set<string>>();

    applyResolvedDataTestId({
      element: el,
      componentName: "MyComp",
      parentComponentName: "MyComp",
      dependencies: deps,
      generatedMethodContentByComponent,
      nativeRole: "button",
      preferredGeneratedValue: staticAttributeValue("ignored"),
      bestKeyPlaceholder: "${item.id}",
      testIdAttribute: "data-testid",
      existingIdBehavior: "preserve",
      addHtmlAttribute: false,
    });

    const entries = Array.from(deps.dataTestIdSet);
    expect(entries.length).toBe(1);
    expect(entries[0]?.pom?.formattedDataTestId).toBe("abc-${key}");
  });

  it("drives applyResolvedDataTestId through option-driven radio handling and de-duping", () => {
    const _wrappers: NativeWrappersMap = { "dx-radio-group": { role: "radio" } };

    const ast = parseTemplate("<dx-radio-group :options=\"['One','Two']\" />");
    const el = firstElement(ast);

    const deps: IComponentDependencies = {
      filePath: "/src/components/MyComp.vue",
      childrenComponentSet: new Set(),
      usedComponentSet: new Set(),
      dataTestIdSet: new Set<IDataTestId>(),
      generatedMethods: new Map(),
      isView: false,
    };

    const generatedMethodContentByComponent = new Map<string, Set<string>>();

    applyResolvedDataTestId({
      element: el,
      componentName: "MyComp",
      parentComponentName: "MyComp",
      dependencies: deps,
      generatedMethodContentByComponent,
      nativeRole: "radio",
      preferredGeneratedValue: staticAttributeValue("MyComp-Foo-radio"),
      bestKeyPlaceholder: null,
      testIdAttribute: "data-testid",
      existingIdBehavior: "overwrite",
      addHtmlAttribute: false,
      entryOverrides: { value: "MyComp-Foo-radio" },
    });

    // Should have generated per-option extra click methods (IR), not raw emitted method strings.
    const extras = deps.pomExtraMethods ?? [];
    expect(extras.length).toBeGreaterThan(0);
    expect(extras.every(e => e.kind === "click")).toBe(true);
    expect(extras.some(e => e.name.startsWith("select"))).toBe(true);
    expect(extras.some(e => e.formattedDataTestId.includes("_radio"))).toBe(true);

    const prevCount = extras.length;

    // Call again to hit the de-dupe path in appendMethodOnce.
    applyResolvedDataTestId({
      element: el,
      componentName: "MyComp",
      parentComponentName: "MyComp",
      dependencies: deps,
      generatedMethodContentByComponent,
      nativeRole: "radio",
      preferredGeneratedValue: staticAttributeValue("MyComp-Foo-radio"),
      bestKeyPlaceholder: null,
      testIdAttribute: "data-testid",
      existingIdBehavior: "overwrite",
      addHtmlAttribute: false,
      entryOverrides: { value: "MyComp-Foo-radio" },
    });

    // De-dupe: calling again should not add more extra methods.
    expect((deps.pomExtraMethods ?? []).length).toBe(prevCount);
  });

  it("covers applyResolvedDataTestId dynamic options method + signature collision handling", () => {
    const el = firstElement(parseTemplate("<dx-radio-group :options=\"options\" />"));

    const deps: IComponentDependencies = {
      filePath: "/src/components/MyComp.vue",
      childrenComponentSet: new Set(),
      usedComponentSet: new Set(),
      dataTestIdSet: new Set<IDataTestId>(),
      generatedMethods: new Map(),
      isView: false,
    };

    const generatedMethodContentByComponent = new Map<string, Set<string>>();

    applyResolvedDataTestId({
      element: el,
      componentName: "MyComp",
      parentComponentName: "MyComp",
      dependencies: deps,
      generatedMethodContentByComponent,
      nativeRole: "radio",
      preferredGeneratedValue: staticAttributeValue("MyComp-radio"),
      bestKeyPlaceholder: null,
      testIdAttribute: "data-testid",
      existingIdBehavior: "overwrite",
      addHtmlAttribute: false,
    });

    const some = "selectRadio";
    const prev = deps.generatedMethods!.get(some);
    expect(prev).not.toBeUndefined();

    // Force a collision on the next registration pass.
    deps.generatedMethods!.set(some, { params: "x: number", argNames: ["x"] });

    applyResolvedDataTestId({
      element: el,
      componentName: "MyComp",
      parentComponentName: "MyComp",
      dependencies: deps,
      generatedMethodContentByComponent,
      nativeRole: "radio",
      // Change the wrapper prefix so the extra method is not semantically de-duped,
      // and the generator has to pick a unique name.
      preferredGeneratedValue: staticAttributeValue("MyComp2-radio"),
      bestKeyPlaceholder: null,
      testIdAttribute: "data-testid",
      existingIdBehavior: "overwrite",
      addHtmlAttribute: false,
    });

    // Because dynamic options use ensureUniqueGeneratedName, collisions produce a suffixed name
    // rather than poisoning the original signature.
    expect(deps.generatedMethods!.get(some)).toEqual({ params: "x: number", argNames: ["x"] });
    expect(deps.generatedMethods!.get("selectRadio2")).toEqual({
      params: "value: string, annotationText: string = \"\"",
      argNames: ["value", "annotationText"],
    });

    // Dynamic options should be represented as a single extra method that interpolates `${value}`.
    const extras = deps.pomExtraMethods ?? [];
    const method1 = extras.find(e => e.kind === "click" && e.name === some);
    expect(method1).toBeTruthy();
    expect(method1?.formattedDataTestId).toContain("${value}");
    expect(method1?.formattedDataTestId).toContain("_radio");

    const method2 = extras.find(e => e.kind === "click" && e.name === "selectRadio2");
    expect(method2).toBeTruthy();
    expect(method2?.formattedDataTestId).toContain("${value}");
    expect(method2?.formattedDataTestId).toContain("_radio");
  });

  it("supports configurable primary POM name collision behavior (error/warn/suffix)", () => {
    const root = parseTemplate("<button /><button />");
    const els = (root.children ?? []).filter((c: any) => c?.type === NodeTypes.ELEMENT) as ElementNode[];
    expect(els.length).toBe(2);

    const makeDeps = (): IComponentDependencies => ({
      filePath: "/src/components/MyComp.vue",
      childrenComponentSet: new Set(),
      usedComponentSet: new Set(),
      dataTestIdSet: new Set<IDataTestId>(),
      generatedMethods: new Map(),
      isView: false,
    });

    // (1) error: throw on first collision
    {
      const deps = makeDeps();
      const generatedMethodContentByComponent = new Map<string, Set<string>>();

      applyResolvedDataTestId({
        element: els[0]!,
        componentName: "MyComp",
        parentComponentName: "MyComp",
        dependencies: deps,
        generatedMethodContentByComponent,
        nativeRole: "button",
        preferredGeneratedValue: staticAttributeValue("MyComp-A-button"),
        bestKeyPlaceholder: null,
        testIdAttribute: "data-testid",
        existingIdBehavior: "overwrite",
        addHtmlAttribute: false,
        nameCollisionBehavior: "error",
      });

      expect(() => {
        applyResolvedDataTestId({
          element: els[1]!,
          componentName: "MyComp",
          parentComponentName: "MyComp",
          dependencies: deps,
          generatedMethodContentByComponent,
          nativeRole: "button",
          preferredGeneratedValue: staticAttributeValue("MyComp-B-button"),
          bestKeyPlaceholder: null,
          testIdAttribute: "data-testid",
          existingIdBehavior: "overwrite",
          addHtmlAttribute: false,
          nameCollisionBehavior: "error",
        });
      }).toThrow(/member-name collision/i);
    }

    // (2) warn: warn and suffix
    {
      const deps = makeDeps();
      const generatedMethodContentByComponent = new Map<string, Set<string>>();
      const warnings: string[] = [];

      applyResolvedDataTestId({
        element: els[0]!,
        componentName: "MyComp",
        parentComponentName: "MyComp",
        dependencies: deps,
        generatedMethodContentByComponent,
        nativeRole: "button",
        preferredGeneratedValue: staticAttributeValue("MyComp-A-button"),
        bestKeyPlaceholder: null,
        testIdAttribute: "data-testid",
        existingIdBehavior: "overwrite",
        addHtmlAttribute: false,
        nameCollisionBehavior: "warn",
        warn: (m) => warnings.push(m),
      });

      applyResolvedDataTestId({
        element: els[1]!,
        componentName: "MyComp",
        parentComponentName: "MyComp",
        dependencies: deps,
        generatedMethodContentByComponent,
        nativeRole: "button",
        preferredGeneratedValue: staticAttributeValue("MyComp-B-button"),
        bestKeyPlaceholder: null,
        testIdAttribute: "data-testid",
        existingIdBehavior: "overwrite",
        addHtmlAttribute: false,
        nameCollisionBehavior: "warn",
        warn: (m) => warnings.push(m),
      });

      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings.some(w => /collision/i.test(w))).toBe(true);

      const poms = Array.from(deps.dataTestIdSet).map(e => e.pom?.methodName).filter(Boolean);
      expect(poms).toContain("Button");
      expect(poms).toContain("Button2");
    }

    // (3) suffix: suffix silently
    {
      const deps = makeDeps();
      const generatedMethodContentByComponent = new Map<string, Set<string>>();
      let warned = false;

      applyResolvedDataTestId({
        element: els[0]!,
        componentName: "MyComp",
        parentComponentName: "MyComp",
        dependencies: deps,
        generatedMethodContentByComponent,
        nativeRole: "button",
        preferredGeneratedValue: staticAttributeValue("MyComp-A-button"),
        bestKeyPlaceholder: null,
        testIdAttribute: "data-testid",
        existingIdBehavior: "overwrite",
        addHtmlAttribute: false,
        nameCollisionBehavior: "suffix",
        warn: () => { warned = true; },
      });

      applyResolvedDataTestId({
        element: els[1]!,
        componentName: "MyComp",
        parentComponentName: "MyComp",
        dependencies: deps,
        generatedMethodContentByComponent,
        nativeRole: "button",
        preferredGeneratedValue: staticAttributeValue("MyComp-B-button"),
        bestKeyPlaceholder: null,
        testIdAttribute: "data-testid",
        existingIdBehavior: "overwrite",
        addHtmlAttribute: false,
        nameCollisionBehavior: "suffix",
        warn: () => { warned = true; },
      });

      expect(warned).toBe(false);
      const poms = Array.from(deps.dataTestIdSet).map(e => e.pom?.methodName).filter(Boolean);
      expect(poms).toContain("Button");
      expect(poms).toContain("Button2");
    }
  });

  it("avoids select/radio action-name collisions by role-suffixing in strict mode", () => {
    const root = parseTemplate("<MySelect /><MyRadioGroup />");
    const els = (root.children ?? []).filter((c: any) => c?.type === NodeTypes.ELEMENT) as ElementNode[];
    expect(els.length).toBe(2);

    const deps: IComponentDependencies = {
      filePath: "/src/components/MyComp.vue",
      childrenComponentSet: new Set(),
      usedComponentSet: new Set(),
      dataTestIdSet: new Set<IDataTestId>(),
      generatedMethods: new Map(),
      isView: false,
    };

    const generatedMethodContentByComponent = new Map<string, Set<string>>();

    applyResolvedDataTestId({
      element: els[0]!,
      componentName: "MyComp",
      parentComponentName: "MyComp",
      dependencies: deps,
      generatedMethodContentByComponent,
      nativeRole: "select",
      semanticNameHint: "ParameterDefaultValue",
      preferredGeneratedValue: staticAttributeValue("MyComp-select"),
      bestKeyPlaceholder: null,
      testIdAttribute: "data-testid",
      existingIdBehavior: "overwrite",
      addHtmlAttribute: false,
      nameCollisionBehavior: "error",
    });

    expect(() => {
      applyResolvedDataTestId({
        element: els[1]!,
        componentName: "MyComp",
        parentComponentName: "MyComp",
        dependencies: deps,
        generatedMethodContentByComponent,
        nativeRole: "radio",
        semanticNameHint: "ParameterDefaultValue",
        preferredGeneratedValue: staticAttributeValue("MyComp-radio"),
        bestKeyPlaceholder: null,
        testIdAttribute: "data-testid",
        existingIdBehavior: "overwrite",
        addHtmlAttribute: false,
        nameCollisionBehavior: "error",
      });
    }).not.toThrow();

    const entries = Array.from(deps.dataTestIdSet);
    const selectEntry = entries.find(e => e.value === "MyComp-select");
    const radioEntry = entries.find(e => e.value === "MyComp-radio");

    expect(selectEntry?.pom?.methodName).toBe("ParameterDefaultValue");
    expect(radioEntry?.pom?.methodName).toBe("ParameterDefaultValueRadio");
  });

  it("covers applyResolvedDataTestId static option labels extracted from array-of-objects", () => {
    const el = firstElement(parseTemplate("<dx-radio-group :options=\"[{ label: 'A' }, { text: `A` }]\" />"));

    const deps: IComponentDependencies = {
      filePath: "/src/components/MyComp.vue",
      childrenComponentSet: new Set(),
      usedComponentSet: new Set(),
      dataTestIdSet: new Set<IDataTestId>(),
      generatedMethods: new Map(),
      isView: false,
    };

    const generatedMethodContentByComponent = new Map<string, Set<string>>();

    applyResolvedDataTestId({
      element: el,
      componentName: "MyComp",
      parentComponentName: "MyComp",
      dependencies: deps,
      generatedMethodContentByComponent,
      nativeRole: "radio",
      preferredGeneratedValue: staticAttributeValue("MyComp-radio"),
      bestKeyPlaceholder: null,
      testIdAttribute: "data-testid",
      existingIdBehavior: "overwrite",
      addHtmlAttribute: false,
    });

    // Duplicate labels that resolve to the same semantic option are de-duped.
    const keys = Array.from(deps.generatedMethods!.keys());
    expect(keys.length).toBe(1);
    expect(keys.some(k => k.endsWith("2"))).toBe(false);
    expect((deps.pomExtraMethods ?? []).length).toBe(1);
  });

  it("covers composed click handler content fallback", () => {
    const ast = parseTemplate("<button>Save</button>");
    const btn = firstElement(ast);
    expect(getComposedClickHandlerContent(btn, { scopes: { vFor: 0 } } as any, "Save")).toBe("");
  });

  it("extracts composed click handler content for @click.prevent call expressions", () => {
    const ast = parseTemplate("<button @click.prevent=\"appPrefEmailBccRemoved(email)\">{{ email }}</button>");
    const btn = firstElement(ast);
    expect(getComposedClickHandlerContent(btn, { scopes: { vFor: 0 } } as any, null)).toBe("-AppPrefEmailBccRemoved");
  });
});
