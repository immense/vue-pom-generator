// @vitest-environment node
import { describe, expect, it } from "vitest";

import type {
  DirectiveNode,
  ElementNode,
  ForNode,
  RootNode,
  SimpleExpressionNode,
  TemplateChildNode,
  TransformContext,
} from "@vue/compiler-core";
import { ConstantTypes, NodeTypes } from "@vue/compiler-core";
import type { CompilerOptions } from "@vue/compiler-dom";
import { baseCompile, parse, parserOptions } from "@vue/compiler-dom";


import { parseExpression } from "@babel/parser";

import { createPomMethodSignature, createPomParameters } from "../pom-params";
import { createPomStringPattern } from "../pom-patterns";
import {
  addComponentTestIds,
  applyResolvedDataTestId,
  analyzeToDirectiveTarget,
  findDataTestIdAttribute,
  findTestIdAttribute,
  formatTagName,
  generateToDirectiveDataTestId,
  getAttributeValueText,
  getComposedClickHandlerContent,
  getContainedInSlotDataKeyInfo,
  getContainedInVForDirectiveKeyInfo,
  getStaticIdOrNameHint,
  getKeyDirectiveInfo,
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
  renderTemplateLiteralExpression,
  setResolveToComponentNameFn,
  setRouteNameToComponentNameMap,
  staticAttributeValue,
  templateAttributeValue,
  toInterpolatedTemplateFragment,
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
  return parse(template, Object.assign({}, parserOptions, { filename }));
}

function compileAndCaptureAst(source: string, options: CompilerOptions & { filename: string }): RootNode {
  let captured: RootNode | null = null;

  baseCompile(
    source,
    Object.assign({}, parserOptions, options, {
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
        const found = visit(c);
        if (found) return found;
      }
    }
    expect(toPascalCase("hello world")).toBe("HelloWorld");
    expect(isSimpleExpressionNode(null)).toBe(false);
    expect(isSimpleExpressionNode({})).toBe(false);
    expect(isSimpleExpressionNode({ type: NodeTypes.SIMPLE_EXPRESSION })).toBe(true);

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

  const visitAny = (node: RootNode | TemplateChildNode) => {
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

  const visitAny = (node: RootNode | TemplateChildNode) => {
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

  const visit = (node: RootNode | TemplateChildNode, parent: ElementNode | null) => {
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
    (p)  =>
      p.type === NodeTypes.DIRECTIVE
      && p.name === "bind"
      && p.arg?.type === NodeTypes.SIMPLE_EXPRESSION
      && p.arg.content === argName,
  );
  const directiveNode = dir as DirectiveNode;
  if (!directiveNode || directiveNode === undefined || directiveNode.exp === undefined) {
    throw new Error(`Missing :${argName} directive with SIMPLE_EXPRESSION`);
  }
  else
    directiveNode.exp.ast = parseExpression(expAstSource, { plugins: ["typescript"] });
}

function clearBindAst(node: ElementNode, argName: string) {
  const dir = node.props.find(
    (p)  =>
      p.type === NodeTypes.DIRECTIVE
      && p.name === "bind"
      && p.arg?.type === NodeTypes.SIMPLE_EXPRESSION
      && p.arg.content === argName,
  );
  const directiveNode = dir as DirectiveNode;
  if (!directiveNode || directiveNode === undefined || directiveNode.exp === undefined) {
    throw new Error(`Missing :${argName} directive with SIMPLE_EXPRESSION`);
  }
  else
    (directiveNode.exp as { ast?: unknown }).ast = null;
}

describe("utils.ts coverage", () => {
  it("covers simple type helpers and click detection", () => {
    expect(toPascalCase("hello world")).toBe("HelloWorld");

    expect(upperFirst("")).toBe("");
    expect(upperFirst("hello")).toBe("Hello");

    expect(isSimpleExpressionNode(null)).toBe(false);
    expect(isSimpleExpressionNode({})).toBe(false);
    expect(isSimpleExpressionNode({ type: NodeTypes.SIMPLE_EXPRESSION })).toBe(true);

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

    expect(analyzeToDirectiveTarget(toDir!)).toMatchObject({
      kind: "resolved",
      routeNameKey: "Users",
      paramKeys: [],
    });

    // Fallback map path
    setResolveToComponentNameFn(null);
    setRouteNameToComponentNameMap(new Map([["Users", "UsersPage"]]));
    expect(getRouteNameKeyFromToDirective(toDir!)).toBe("Users");
    expect(tryResolveToDirectiveTargetComponentName(toDir!)).toBe("UsersPage");

    // resolveToComponentName path (also exercises object `params` placeholder building)
    setRouteNameToComponentNameMap(null);
    setResolveToComponentNameFn((to) => {
      if (typeof to === "string") return null;
      const keys = Object.keys((to).params ?? {}).sort();
      expect(keys).toEqual(["id"]);
      expect(to.params?.id).toBe("__placeholder__");
      return "UsersViaResolve";
    });

    const ast2 = parseTemplate("<RouterLink :to=\"{ name: 'users', params: { id: foo } }\">Users</RouterLink>");
    const el2 = firstElement(ast2);
    const toDir2 = nodeHasToDirective(el2);
    expect(analyzeToDirectiveTarget(toDir2!)).toMatchObject({
      kind: "resolved",
      routeNameKey: "Users",
      paramKeys: ["id"],
    });
    expect(tryResolveToDirectiveTargetComponentName(toDir2!)).toBe("UsersViaResolve");
  });

  it("distinguishes unsupported and parse-error :to directive shapes", () => {
    const unsupportedAst = parseTemplate("<RouterLink :to=\"routeTarget\">Users</RouterLink>");
    const unsupportedDir = nodeHasToDirective(firstElement(unsupportedAst));
    expect(analyzeToDirectiveTarget(unsupportedDir!)).toMatchObject({
      kind: "unsupported",
      reason: "dynamic-expression",
    });

    const parseErrorAst = parseTemplate("<RouterLink :to=\"foo(\">Users</RouterLink>");
    const parseErrorDir = nodeHasToDirective(firstElement(parseErrorAst));
    expect(analyzeToDirectiveTarget(parseErrorDir!)).toMatchObject({
      kind: "parse-error",
      reason: "parse-error",
    });
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

  it("derives :handler semanticNameHint from later stable call arguments when leading args are dynamic", () => {
    const root = parseTemplate(`
      <LoadButton :handler="() => runDeploymentAction(rowData, 'Assign', RebootPreference.Suppress)">
        Assign
      </LoadButton>
    `);
    const el = firstElement(root);

    const info = nodeHandlerAttributeInfo(el);
    expect(info).toBeTruthy();
    expect(info?.semanticNameHint).toBe("RunDeploymentActionAssignSuppress");
  });

  it("derives :handler semanticNameHint from async await call lambdas", () => {
    const root = parseTemplate(`
      <LoadButton :handler="async () => await refreshOauthAccessToken(data.id)">
        Refresh now
      </LoadButton>
    `);
    const el = firstElement(root);

    const info = nodeHandlerAttributeInfo(el);
    expect(info).toBeTruthy();
    expect(info?.semanticNameHint).toBe("RefreshOauthAccessToken");
    expect(nodeHandlerAttributeValue(el)).toBe("RefreshOauthAccessToken");
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

  it("derives :handler semanticNameHint from logical-expression arrow bodies", () => {
    const root = parseTemplate(`
      <LoadButton :handler="() => person && impersonateUser(person.userId!)">Impersonate</LoadButton>
    `);
    const el = firstElement(root);

    expect(nodeHandlerAttributeInfo(el)?.semanticNameHint).toBe("ImpersonateUser");
  });

  it("handles :key extraction paths", () => {
    const ast = parseTemplate("<div :key=\"item.id\" />");
    const el = firstElement(ast);
    expect(getKeyDirectiveInfo(el)).toEqual({
      selectorFragment: "${item.id}",
      runtimeFragment: "${item.id}",
      rawExpression: "item.id",
    });

    const ast2 = parseTemplate("<Foo v-for=\"x in xs\" :key=\"x.id\" />");
    const foo = firstElement(ast2);
    expect(foo.isSelfClosing).toBe(true);
    expect(getSelfClosingForDirectiveKeyAttrValue(foo)).toBe("${x.id}");

    const ast3 = parseTemplate("<Foo :key=\"x.id\"></Foo>");
    const foo2 = firstElement(ast3);
    expect(Boolean(foo2.isSelfClosing)).toBe(false);
    expect(getSelfClosingForDirectiveKeyAttrValue(foo2)).toBeNull();

    const ast4 = parseTemplate("<div :key=\"`line-${item.id}`\" />");
    const el4 = firstElement(ast4);
    expect(getKeyDirectiveInfo(el4)).toEqual({
      selectorFragment: "line-${item.id}",
      runtimeFragment: "line-${item.id}",
      rawExpression: null,
    });
  });

  it("normalizes key fragments into template-safe output", () => {
    expect(toInterpolatedTemplateFragment("item.id")).toEqual({
      template: "${item.id}",
      rawExpression: "item.id",
    });
    expect(toInterpolatedTemplateFragment("line-${item.id}")).toEqual({
      template: "line-${item.id}",
      rawExpression: null,
    });
    const templateValue = templateAttributeValue("line-${item.id}");
    expect(templateValue.kind).toBe("template");
    if (templateValue.kind === "template") {
      expect(renderTemplateLiteralExpression(templateValue)).toBe("`line-${item.id}`");
    }
  });

  it("extracts id/name identifiers", () => {
    expect(getStaticIdOrNameHint(firstElement(parseTemplate("<div id=\"foo-bar\" />")))).toBe("FooBar");
    expect(getStaticIdOrNameHint(firstElement(parseTemplate("<div name=\"foo_bar\" />")))).toBe("FooBar");
    const dyn = firstElement(parseTemplate("<div :id=\"something\" />"));
    expect(getStaticIdOrNameHint(dyn)).toBe("");
    const dynName = firstElement(parseTemplate("<div :name=\"something\" />"));
    expect(getStaticIdOrNameHint(dynName)).toBe("");
  });

  it("extracts :handler semantic hints from common patterns", () => {
    const direct = firstElement(parseTemplate("<LoadButton :handler=\"approveChangeRequest\" />"));
    expect(nodeHandlerAttributeValue(direct)).toBe("ApproveChangeRequest");
    expect(nodeHandlerAttributeInfo(direct)?.mergeKey).toBe("handler:expr:approveChangeRequest");

    const rewritten = firstElement(parseTemplate("<LoadButton :handler=\"saveNotes\" />"));
    const rewrittenDirective = rewritten.props.find((prop): prop is DirectiveNode => {
      return prop.type === NodeTypes.DIRECTIVE
        && prop.name === "bind"
        && prop.arg?.type === NodeTypes.SIMPLE_EXPRESSION
        && prop.arg.content === "handler";
    });
    expect(rewrittenDirective?.exp?.type).toBe(NodeTypes.SIMPLE_EXPRESSION);
    (rewrittenDirective?.exp as SimpleExpressionNode).content = "_unref(saveNotes)";
    expect(nodeHandlerAttributeValue(rewritten)).toBe("SaveNotes");
    expect(nodeHandlerAttributeInfo(rewritten)?.mergeKey).toBe("handler:expr:saveNotes");

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

  it("extracts slot-scope key info from compiled slot bindings", () => {
    const compiled = compileAndCaptureAst(
      "<MyList><template #item=\"{ data }\"><div><span>Hi</span></div></template></MyList>",
      { filename: "/src/components/Test.vue" },
    );
    const map = buildHierarchyMap(compiled);
    const span = findFirstTag(compiled, "span");

    expect(getContainedInSlotDataKeyInfo(span, map)).toEqual({
      selectorFragment: "${data.key ?? data.data?.id ?? data.id ?? data.value ?? data}",
      runtimeFragment: "${data.key ?? data.data?.id ?? data.id ?? data.value ?? data}",
      rawExpression: "data.key ?? data.data?.id ?? data.id ?? data.value ?? data",
    });
  });

  it("walks v-for scopes for :key and infers static iterable literals", () => {
    const ast = parseTemplate("<div v-for=\"item in items\" :key=\"item.id\"><span /></div>");
    const span = findFirstTag(ast, "span");
    const map = buildHierarchyMap(ast);

    expect(getContainedInVForDirectiveKeyInfo({ scopes: { vFor: 0 } } as TransformContext, span, map)).toBeNull();
    expect(getContainedInVForDirectiveKeyInfo({ scopes: { vFor: 1 } } as TransformContext, span, map)).toEqual({
      selectorFragment: "${item.id}",
      runtimeFragment: "${item.id}",
      rawExpression: "item.id",
    });

    const astStatic = compileAndCaptureAst(
      "<div v-for=\"item in ['One','Two']\" :key=\"item\"><span /></div>",
      { filename: "/src/components/Test.vue" },
    );
    const forNode = findFirstForNode(astStatic);

    const ctx = { scopes: { vFor: 1 }, parent: forNode } as TransformContext;
    const values = tryGetContainedInStaticVForSourceLiteralValues(ctx, {} as ElementNode, buildHierarchyMap(astStatic));
    expect(values).toEqual(["One", "Two"]);

    const astStaticTpl = compileAndCaptureAst(
      "<div v-for=\"item in [`One`, `Two`]\" :key=\"item\"><span /></div>",
      { filename: "/src/components/Test.vue" },
    );
    const forNodeTpl = findFirstForNode(astStaticTpl);
    const ctxTpl = { scopes: { vFor: 1 }, parent: forNodeTpl } as TransformContext;
    const valuesTpl = tryGetContainedInStaticVForSourceLiteralValues(ctxTpl, {} as ElementNode, buildHierarchyMap(astStaticTpl));
    expect(valuesTpl).toEqual(["One", "Two"]);

    // Branches: NOT_CONSTANT => null
    const fakeSimple = { type: NodeTypes.SIMPLE_EXPRESSION, constType: ConstantTypes.NOT_CONSTANT };
    const fakeFor = { type: NodeTypes.FOR, source: fakeSimple };
    expect(tryGetContainedInStaticVForSourceLiteralValues({ scopes: { vFor: 1 }, parent: fakeFor } as TransformContext, {} as ElementNode, buildHierarchyMap(astStatic))).toBeNull();
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

  it("does not treat inferred wrappers with only :modelValue as standalone wrapper controls", () => {
    const wrappers: NativeWrappersMap = { "shared-radio": { role: "radio", inferred: true } };

    const node = firstElement(parseTemplate("<shared-radio :modelValue=\"option.value\" :selected=\"currentFilter\" />"));
    setBindAst(node, "modelValue", "option.value");

    const info = getNativeWrapperTransformInfo(node, "Comp", wrappers);
    expect(info.nativeWrappersValue).toBeNull();
    expect(info.optionDataTestIdPrefixValue).toBeNull();
  });

  it("generates :to data-testid values across primary shapes", () => {
    const wrappers: NativeWrappersMap = {};

    // object literal name + inner text
    const ast = parseTemplate("<RouterLink :to=\"{ name: 'Users' }\">Go</RouterLink>");
    const el = firstElement(ast);
    const toDir = nodeHasToDirective(el)!;
    const id1 = generateToDirectiveDataTestId("MyComp", el, toDir, { scopes: { vFor: 0 } } as TransformContext, new Map(), wrappers);
    expect(getAttributeValueText(id1!)).toBe("MyComp-Users-Go-routerlink");

    // string expression (no static name)
    const ast2 = parseTemplate("<RouterLink :to=\"toVar\">Go</RouterLink>");
    const el2 = firstElement(ast2);
    const toDir2 = nodeHasToDirective(el2)!;
    const id2 = generateToDirectiveDataTestId("MyComp", el2, toDir2, { scopes: { vFor: 0 } } as TransformContext, new Map(), wrappers);
    expect(id2!.kind).toBe("template");
    expect(getAttributeValueText(id2!)).toContain("toVar");

    // key-driven path
    const ast3 = parseTemplate("<RouterLink v-for=\"item in items\" :key=\"item.id\" :to=\"{ name: 'Users' }\">Go</RouterLink>");
    const el3 = firstElement(ast3);
    const toDir3 = nodeHasToDirective(el3)!;
    const id3 = generateToDirectiveDataTestId("MyComp", el3, toDir3, { scopes: { vFor: 1 } } as TransformContext, buildHierarchyMap(ast3), wrappers);
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

  it("covers tryGetExistingElementDataTestId AST-based simple member-expression path", () => {
    const node = firstElement(parseTemplate("<div :data-testid=\"p.parameter.name\" />"));
    setBindAst(node, "data-testid", "p.parameter.name");
    const info = tryGetExistingElementDataTestId(node);
    expect(info?.isDynamic).toBe(true);
    expect(info?.isStaticLiteral).toBe(false);
    expect(info?.value).toBe("p.parameter.name");
    expect(info?.template).toBe("${p.parameter.name}");
    expect(info?.templateExpressionCount).toBe(1);
    expect(info?.rawExpression).toBe("p.parameter.name");
  });

  it("re-parses existing bound test ids through the shared Vue-expression AST helper when compiler ast is absent", () => {
    const node = firstElement(parseTemplate("<div :data-testid=\"p.parameter.name\" />"));
    clearBindAst(node, "data-testid");

    const info = tryGetExistingElementDataTestId(node);
    expect(info?.isDynamic).toBe(true);
    expect(info?.isStaticLiteral).toBe(false);
    expect(info?.value).toBe("p.parameter.name");
    expect(info?.template).toBe("${p.parameter.name}");
    expect(info?.templateExpressionCount).toBe(1);
    expect(info?.rawExpression).toBe("p.parameter.name");
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
        keyInfo: null,
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
      keyInfo: {
        selectorFragment: "${item.id}",
        runtimeFragment: "${item.id}",
        rawExpression: "item.id",
      },
      testIdAttribute: "data-testid",
      existingIdBehavior: "preserve",
      addHtmlAttribute: false,
    });

    const entries = Array.from(deps.dataTestIdSet);
    expect(entries.length).toBe(1);
    expect(entries[0]?.pom?.selector).toEqual(createPomStringPattern("abc-${key}", "parameterized"));
  });

  it("allows preserving an existing template when the required key fragment carries literal context", () => {
    const el = firstElement(parseTemplate("<button :data-testid=\"`abc-line-${item.id}`\" />"));
    setBindAst(el, "data-testid", "`abc-line-${item.id}`");

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
      keyInfo: {
        selectorFragment: "line-${item.id}",
        runtimeFragment: "line-${item.id}",
        rawExpression: null,
      },
      testIdAttribute: "data-testid",
      existingIdBehavior: "preserve",
      addHtmlAttribute: false,
    });

    const entries = Array.from(deps.dataTestIdSet);
    expect(entries.length).toBe(1);
    expect(entries[0]?.pom?.selector).toEqual(createPomStringPattern("abc-line-${key}", "parameterized"));
  });

  it("allows preserving an existing key-based template literal that uses a fallback branch access", () => {
    const el = firstElement(parseTemplate("<button :data-testid=\"`abc-${data.id}`\" />"));
    setBindAst(el, "data-testid", "`abc-${data.id}`");

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
      keyInfo: {
        selectorFragment: "${data.key ?? data.data?.id ?? data.id ?? data.value ?? data}",
        runtimeFragment: "${data.key ?? data.data?.id ?? data.id ?? data.value ?? data}",
        rawExpression: "data.key ?? data.data?.id ?? data.id ?? data.value ?? data",
      },
      testIdAttribute: "data-testid",
      existingIdBehavior: "preserve",
      addHtmlAttribute: false,
    });

    const entries = Array.from(deps.dataTestIdSet);
    expect(entries.length).toBe(1);
    expect(entries[0]?.pom?.selector).toEqual(createPomStringPattern("abc-${key}", "parameterized"));
  });

  it("allows preserving an existing simple member-expression data-testid", () => {
    const el = firstElement(parseTemplate("<button :data-testid=\"p.parameter.name\" />"));
    setBindAst(el, "data-testid", "p.parameter.name");

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
      keyInfo: {
        selectorFragment: "${p.parameter.name}",
        runtimeFragment: "${p.parameter.name}",
        rawExpression: "p.parameter.name",
      },
      testIdAttribute: "data-testid",
      existingIdBehavior: "preserve",
      addHtmlAttribute: false,
    });

    const entries = Array.from(deps.dataTestIdSet);
    expect(entries.length).toBe(1);
    expect(entries[0]?.selectorValue).toEqual(createPomStringPattern("${p.parameter.name}", "parameterized"));
    expect(entries[0]?.pom?.selector).toEqual(createPomStringPattern("${key}", "parameterized"));
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
      keyInfo: null,
      testIdAttribute: "data-testid",
      existingIdBehavior: "overwrite",
      nameCollisionBehavior: "suffix",
      addHtmlAttribute: false,
      entryOverrides: { selectorValue: createPomStringPattern("MyComp-Foo-radio", "static") },
    });

    // Should have generated per-option extra click methods (IR), not raw emitted method strings.
    const extras = deps.pomExtraMethods ?? [];
    expect(extras.length).toBeGreaterThan(0);
    expect(extras.every(e => e.kind === "click")).toBe(true);
    expect(extras.some(e => e.name.startsWith("select"))).toBe(true);
    expect(extras.every(e => e.selector.kind === "withinTestIdByLabel")).toBe(true);
    expect(extras.some(e => e.selector.kind === "withinTestIdByLabel" && e.selector.rootTestId.formatted === "MyComp-Foo-radio")).toBe(true);
    expect(extras.some(e => e.selector.kind === "withinTestIdByLabel" && e.selector.label.formatted === "One")).toBe(true);

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
      keyInfo: null,
      testIdAttribute: "data-testid",
      existingIdBehavior: "overwrite",
      nameCollisionBehavior: "suffix",
      addHtmlAttribute: false,
      entryOverrides: { selectorValue: createPomStringPattern("MyComp-Foo-radio", "static") },
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
      keyInfo: null,
      testIdAttribute: "data-testid",
      existingIdBehavior: "overwrite",
      nameCollisionBehavior: "suffix",
      addHtmlAttribute: false,
    });

    const some = "selectRadio";
    const prev = deps.generatedMethods!.get(some);
    expect(prev).not.toBeUndefined();

    // Force a collision on the next registration pass.
    deps.generatedMethods!.set(some, createPomMethodSignature(createPomParameters(["x", "number"])));

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
      keyInfo: null,
      testIdAttribute: "data-testid",
      existingIdBehavior: "overwrite",
      nameCollisionBehavior: "suffix",
      addHtmlAttribute: false,
    });

    // Because dynamic options use ensureUniqueGeneratedName, collisions produce a suffixed name
    // rather than poisoning the original signature.
    expect(deps.generatedMethods!.get(some)).toEqual(createPomMethodSignature(createPomParameters(["x", "number"])));
    expect(deps.generatedMethods!.get("selectRadio2")).toEqual(
      createPomMethodSignature(createPomParameters(
        ["value", "string"],
        ["annotationText", "string = \"\""],
      )),
    );

    // Dynamic options should be represented as a single extra method that interpolates `${value}`.
    const extras = deps.pomExtraMethods ?? [];
    const method1 = extras.find(e => e.kind === "click" && e.name === some);
    expect(method1).toBeTruthy();
    expect(method1?.selector).toEqual({
      kind: "withinTestIdByLabel",
      rootTestId: createPomStringPattern("MyComp-radio", "static"),
      label: createPomStringPattern("${value}", "parameterized"),
      exact: true,
    });

    const method2 = extras.find(e => e.kind === "click" && e.name === "selectRadio2");
    expect(method2).toBeTruthy();
    expect(method2?.selector).toEqual({
      kind: "withinTestIdByLabel",
      rootTestId: createPomStringPattern("MyComp2-radio", "static"),
      label: createPomStringPattern("${value}", "parameterized"),
      exact: true,
    });
  });

  it("supports configurable primary POM name collision behavior (error/warn/suffix)", () => {
    const root = parseTemplate("<button /><button />");
    const els = (root.children ?? []).filter((c) => c?.type === NodeTypes.ELEMENT) as ElementNode[];
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
        keyInfo: null,
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
          keyInfo: null,
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
        keyInfo: null,
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
        keyInfo: null,
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
        keyInfo: null,
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
        keyInfo: null,
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

  it("merges keyed primaries with identical selectors before strict role suffixing invents duplicates", () => {
    const root = parseTemplate("<ImmyNavItem /><ImmyNavItem />");
    const els = (root.children ?? []).filter((c) => c?.type === NodeTypes.ELEMENT) as ElementNode[];
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

    const applyKeyedPrimary = (element: ElementNode) => {
      applyResolvedDataTestId({
        element,
        componentName: "MyComp",
        parentComponentName: "MyComp",
        dependencies: deps,
        generatedMethodContentByComponent,
        nativeRole: "button",
        preferredGeneratedValue: templateAttributeValue("MyComp-${value}-immynavitem"),
        keyInfo: null,
        testIdAttribute: "data-testid",
        existingIdBehavior: "overwrite",
        addHtmlAttribute: false,
        nameCollisionBehavior: "error",
        semanticNameHint: "Value",
      });
    };

    applyKeyedPrimary(els[0]!);
    applyKeyedPrimary(els[1]!);

    const poms = Array.from(deps.dataTestIdSet)
      .map(entry => entry.pom)
      .filter((pom): pom is NonNullable<IDataTestId["pom"]> => !!pom);
    const primaryPoms = poms.filter(pom => pom.emitPrimary !== false);
    const mergedPoms = poms.filter(pom => pom.emitPrimary === false);

    expect(primaryPoms.map(pom => pom.methodName)).toEqual(["ValueByKey"]);
    expect(mergedPoms.map(pom => pom.methodName)).toEqual(["ValueByKey"]);
    expect(poms.some(pom => pom.methodName === "ValueButtonByKey")).toBe(false);
    expect(Array.from(deps.generatedMethods?.keys() ?? [])).toContain("clickValueByKey");
    expect(Array.from(deps.generatedMethods?.keys() ?? [])).not.toContain("clickValueButtonByKey");
  });

  it("avoids select/radio action-name collisions by role-suffixing in strict mode", () => {
    const root = parseTemplate("<MySelect /><MyRadioGroup />");
    const els = (root.children ?? []).filter((c) => c?.type === NodeTypes.ELEMENT) as ElementNode[];
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
      keyInfo: null,
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
        keyInfo: null,
        testIdAttribute: "data-testid",
        existingIdBehavior: "overwrite",
        addHtmlAttribute: false,
        nameCollisionBehavior: "error",
      });
    }).not.toThrow();

    const entries = Array.from(deps.dataTestIdSet);
    const selectEntry = entries.find(e => e.selectorValue.formatted === "MyComp-select");
    const radioEntry = entries.find(e => e.selectorValue.formatted === "MyComp-radio");

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
      keyInfo: null,
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
    expect(getComposedClickHandlerContent(btn, { scopes: { vFor: 0 } } as TransformContext, "Save")).toBe("");
  });

  it("extracts composed click handler content for @click.prevent call expressions", () => {
    const ast = parseTemplate("<button @click.prevent=\"appPrefEmailBccRemoved(email)\">{{ email }}</button>");
    const btn = firstElement(ast);
    expect(getComposedClickHandlerContent(btn, { scopes: { vFor: 0 }} as TransformContext, null)).toBe("-AppPrefEmailBccRemoved");
  });

  it("extracts composed click handler content for assignment expressions", () => {
    const ast = parseTemplate("<button @click=\"showUnlinkConfirmationModal = true\">Unlink</button>");
    const btn = firstElement(ast);
    expect(getComposedClickHandlerContent(btn, { scopes: { vFor: 0 }} as TransformContext, null)).toBe("-SetShowUnlinkConfirmationModalTrue");

    const refAst = parseTemplate("<button @click=\"showModal.value = true\">Show</button>");
    const refBtn = firstElement(refAst);
    expect(getComposedClickHandlerContent(refBtn, { scopes: { vFor: 0 }} as TransformContext, null)).toBe("-SetShowModalTrue");
  });
});
