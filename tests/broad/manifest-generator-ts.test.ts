// @vitest-environment node
import { describe, expect, it } from "vitest";

import { createPomStringPattern } from "../../pom-patterns";
import {
  generatePomManifestModule,
  generateTestIdsModule,
} from "../../manifest-generator";
import type { IComponentDependencies, IDataTestId, PomExtraClickMethodSpec, PomPrimarySpec } from "../../utils";
import type { ElementMetadata } from "../../metadata-collector";

function pom(
  overrides: Partial<PomPrimarySpec> = {},
): PomPrimarySpec {
  return {
    nativeRole: "button",
    methodName: "Save",
    selector: createPomStringPattern("save", "static", []),
    parameters: [],
    generatedActionName: "clickSave",
    generatedPropertyName: "SaveButton",
    ...overrides,
  };
}

function entry(overrides: Partial<IDataTestId> = {}): IDataTestId {
  return {
    selectorValue: createPomStringPattern("save", "static", []),
    pom: pom(),
    ...overrides,
  };
}

function deps(
  dataTestIdSet: Set<IDataTestId>,
  overrides: Partial<IComponentDependencies> = {},
): IComponentDependencies {
  return {
    filePath: "/repo/src/Foo.vue",
    childrenComponentSet: new Set<string>(),
    usedComponentSet: new Set<string>(),
    dataTestIdSet,
    isView: false,
    ...overrides,
  };
}

describe("manifest-generator.ts generateTestIdsModule / generatePomManifestModule", () => {
  it("emits both manifests with entries, accessibility, generated names, and metadata fields", () => {
    const primarySelector = createPomStringPattern("save-button", "static", []);
    const primaryPom = pom({
      methodName: "SaveButton",
      selector: primarySelector,
      generatedActionName: "clickSaveButton",
      generatedPropertyName: "SaveButton",
    });

    // An extra click method whose selector matches the primary selector (testId kind, same formatted + patternKind).
    const matchingExtra: PomExtraClickMethodSpec = {
      kind: "click",
      name: "clickSaveButtonAlt",
      selector: { kind: "testId", testId: primarySelector },
      parameters: [],
    };
    // An extra click method whose selector does NOT match (different testId formatted).
    const nonMatchingExtra: PomExtraClickMethodSpec = {
      kind: "click",
      name: "clickOther",
      selector: { kind: "testId", testId: createPomStringPattern("other", "static", []) },
      parameters: [],
    };

    const dataTestIdSet = new Set<IDataTestId>([
      {
        selectorValue: primarySelector,
        pom: primaryPom,
        targetPageObjectModelClass: "DetailsPage",
      },
    ]);

    const componentHierarchyMap = new Map<string, IComponentDependencies>([
      ["SaveView", deps(dataTestIdSet, {
        filePath: "/repo/src/views/Save.vue",
        isView: true,
        pomExtraMethods: [matchingExtra, nonMatchingExtra],
      })],
    ]);

    const elementMetadata = new Map<string, Map<string, ElementMetadata>>([
      ["SaveView", new Map<string, ElementMetadata>([
        ["save-button", {
          testId: "save-button",
          semanticName: "save form",
          tag: "button",
          tagType: 0,
          patchFlag: 39,
          dynamicProps: ["class", "style"],
          hasClickHandler: true,
          hasDynamicClass: true,
          hasDynamicStyle: true,
          hasDynamicText: true,
          staticAriaLabel: "Save",
          staticRole: "button",
          staticTextContent: "Save",
          sourceLine: 5,
          sourceColumn: 2,
        }],
      ])],
    ]);

    const code = generateTestIdsModule(componentHierarchyMap, elementMetadata);

    // Both manifests present.
    expect(code).toContain("export const testIdManifest");
    expect(code).toContain("export const pomManifest");

    // The matching extra action name is included; the non-matching one is excluded.
    // generatedActionNames dedupes: [clickSaveButton, clickSaveButtonAlt] (sorted).
    expect(code).toContain("\"clickSaveButton\"");
    expect(code).toContain("\"clickSaveButtonAlt\"");
    expect(code).not.toContain("\"clickOther\"");

    // Accessibility audit fields derived from metadata + role.
    expect(code).toContain("\"accessibleNameSource\": \"aria-label\"");
    expect(code).toContain("\"needsReview\": false");
    expect(code).toContain("\"staticAriaLabel\": \"Save\"");

    // semanticName comes from metadata when present.
    expect(code).toContain("\"semanticName\": \"save form\"");
    // locatorDescription built from pom.
    expect(code).toContain("\"locatorDescription\":");
    // inferredRole from pom.nativeRole.
    expect(code).toContain("\"inferredRole\": \"button\"");
    // generatedPropertyName from pom.
    expect(code).toContain("\"generatedPropertyName\": \"SaveButton\"");
    // emitPrimary defaults to true.
    expect(code).toContain("\"emitPrimary\": true");
    // targetPageObjectModelClass propagated from entry.
    expect(code).toContain("\"targetPageObjectModelClass\": \"DetailsPage\"");

    // Metadata-sourced fields propagated.
    expect(code).toContain("\"sourceTag\": \"button\"");
    expect(code).toContain("\"sourceTagType\": 0");
    expect(code).toContain("\"sourceLine\": 5");
    expect(code).toContain("\"sourceColumn\": 2");
    expect(code).toContain("\"patchFlag\": 39");
    expect(code).toContain("\"dynamicProps\":");
    expect(code).toContain("\"hasClickHandler\": true");
    expect(code).toContain("\"hasDynamicClass\": true");
    expect(code).toContain("\"hasDynamicStyle\": true");
    expect(code).toContain("\"hasDynamicText\": true");

    // Component kind derived from isView.
    expect(code).toContain("\"kind\": \"view\"");
    expect(code).toContain("\"sourceFile\": \"/repo/src/views/Save.vue\"");
  });

  it("falls back to humanized method name for semanticName and uses buildPomLocatorDescription for locatorDescription when metadata is absent but pom present", () => {
    const dataTestIdSet = new Set<IDataTestId>([
      entry({
        selectorValue: createPomStringPattern("submit-thing", "static", []),
        pom: pom({
          methodName: "SubmitThing",
          selector: createPomStringPattern("submit-thing", "static", []),
          generatedActionName: "clickSubmitThing",
          generatedPropertyName: "SubmitThingButton",
        }),
      }),
    ]);

    const componentHierarchyMap = new Map<string, IComponentDependencies>([
      ["MyComp", deps(dataTestIdSet)],
    ]);

    // No elementMetadata for this component -> metadata is undefined.
    const code = generateTestIdsModule(componentHierarchyMap, new Map());
    // semanticName falls back to humanizePomMethodName("SubmitThing").
    expect(code).toContain("\"semanticName\": \"submit thing\"");
    // locatorDescription is built from pom via buildPomLocatorDescription (componentName + method + role).
    expect(code).toContain("\"locatorDescription\": \"My comp submit thing button\"");
    // inferredRole present; accessibility undefined when metadata undefined (no accessibility field).
    expect(code).toContain("\"inferredRole\": \"button\"");
    expect(code).not.toContain("\"accessibility\"");
    // generatedActionName present.
    expect(code).toContain("\"generatedActionName\": \"clickSubmitThing\"");
  });

  it("uses testId as semanticName and componentName as locatorDescription when pom is absent", () => {
    const dataTestIdSet = new Set<IDataTestId>([
      { selectorValue: createPomStringPattern("raw-id", "static", []) },
    ]);

    const componentHierarchyMap = new Map<string, IComponentDependencies>([
      ["Plain", deps(dataTestIdSet)],
    ]);

    const code = generateTestIdsModule(componentHierarchyMap, new Map());
    // pom null -> semanticName = testId, locatorDescription = componentName.
    expect(code).toContain("\"semanticName\": \"raw-id\"");
    expect(code).toContain("\"locatorDescription\": \"Plain\"");
    // inferredRole null, generatedPropertyName null, generatedActionName null.
    expect(code).toContain("\"inferredRole\": null");
    expect(code).toContain("\"generatedPropertyName\": null");
    expect(code).toContain("\"generatedActionName\": null");
    // generatedActionNames empty array.
    expect(code).toContain("\"generatedActionNames\": []");
    // emitPrimary true (pom?.emitPrimary !== false -> true when pom undefined).
    expect(code).toContain("\"emitPrimary\": true");
  });

  it("excludes components with no data-testid entries from both manifests (lines 124-125, 150-151)", () => {
    const componentHierarchyMap = new Map<string, IComponentDependencies>([
      ["Empty", deps(new Set<IDataTestId>())],
      ["HasEntries", deps(new Set<IDataTestId>([entry({
        selectorValue: createPomStringPattern("has", "static", []),
        pom: pom({
          methodName: "Has",
          selector: createPomStringPattern("has", "static", []),
          generatedActionName: "clickHas",
          generatedPropertyName: "HasButton",
        }),
      })]))],
    ]);

    const code = generateTestIdsModule(componentHierarchyMap, new Map());
    expect(code).not.toContain("\"Empty\"");
    expect(code).toContain("\"HasEntries\"");
  });

  it("emits a parameterized selector pattern kind and dedupes testIds", () => {
    const paramSelector = createPomStringPattern("item-${key}", "parameterized", ["key"]);
    const dataTestIdSet = new Set<IDataTestId>([
      entry({
        selectorValue: paramSelector,
        pom: pom({
          methodName: "ItemByKey",
          selector: paramSelector,
          generatedActionName: "clickItemByKey",
          generatedPropertyName: "ItemButton",
        }),
      }),
    ]);

    const componentHierarchyMap = new Map<string, IComponentDependencies>([
      ["Items", deps(dataTestIdSet)],
    ]);

    const code = generateTestIdsModule(componentHierarchyMap, new Map());
    expect(code).toContain("\"selectorPatternKind\": \"parameterized\"");
  });

  it("generatePomManifestModule emits only the pom manifest and type aliases", () => {
    const dataTestIdSet = new Set<IDataTestId>([entry()]);
    const componentHierarchyMap = new Map<string, IComponentDependencies>([
      ["Solo", deps(dataTestIdSet)],
    ]);

    const code = generatePomManifestModule(componentHierarchyMap, new Map());
    expect(code).toContain("export const pomManifest");
    expect(code).not.toContain("export const testIdManifest");
    expect(code).toContain("export type PomManifestComponentName");
    expect(code).toContain("\"Solo\"");
  });

  it("sorts components and testIds deterministically (line 118 sort)", () => {
    const componentHierarchyMap = new Map<string, IComponentDependencies>([
      ["Zeta", deps(new Set<IDataTestId>([entry({
        selectorValue: createPomStringPattern("z", "static", []),
        pom: pom({ methodName: "Z", selector: createPomStringPattern("z", "static", []), generatedActionName: "clickZ", generatedPropertyName: "ZButton" }),
      })]))],
      ["Alpha", deps(new Set<IDataTestId>([entry({
        selectorValue: createPomStringPattern("a", "static", []),
        pom: pom({ methodName: "A", selector: createPomStringPattern("a", "static", []), generatedActionName: "clickA", generatedPropertyName: "AButton" }),
      })]))],
    ]);

    const code = generateTestIdsModule(componentHierarchyMap, new Map());
    const alphaIdx = code.indexOf("\"Alpha\"");
    const zetaIdx = code.indexOf("\"Zeta\"");
    expect(alphaIdx).toBeGreaterThan(-1);
    expect(zetaIdx).toBeGreaterThan(-1);
    expect(alphaIdx).toBeLessThan(zetaIdx);
  });

  it("matchesPrimarySelector returns false for a non-testId selector kind (line 50-51 branch)", () => {
    // An extra method with withinTestIdByLabel selector should NOT be matched as a primary action name.
    const primarySelector = createPomStringPattern("root", "static", []);
    const labelExtra: PomExtraClickMethodSpec = {
      kind: "click",
      name: "clickByLabel",
      selector: {
        kind: "withinTestIdByLabel",
        rootTestId: primarySelector,
        label: createPomStringPattern("Go", "static", []),
      },
      parameters: [],
    };

    const dataTestIdSet = new Set<IDataTestId>([
      entry({
        selectorValue: primarySelector,
        pom: pom({
          methodName: "Root",
          selector: primarySelector,
          generatedActionName: "clickRoot",
          generatedPropertyName: "RootButton",
        }),
      }),
    ]);

    const componentHierarchyMap = new Map<string, IComponentDependencies>([
      ["Lbl", deps(dataTestIdSet, { pomExtraMethods: [labelExtra] })],
    ]);

    const code = generateTestIdsModule(componentHierarchyMap, new Map());
    // The label-based extra method is excluded because its selector kind is not "testId".
    expect(code).toContain("\"clickRoot\"");
    expect(code).not.toContain("\"clickByLabel\"");
  });

  it("matchesPrimarySelector returns false when testId formatted differs (mismatch branch)", () => {
    const primarySelector = createPomStringPattern("primary", "static", []);
    const dataTestIdSet = new Set<IDataTestId>([
      entry({
        selectorValue: primarySelector,
        pom: pom({
          methodName: "Primary",
          selector: primarySelector,
          generatedActionName: "clickPrimary",
          generatedPropertyName: "PrimaryButton",
        }),
      }),
    ]);

    // Extra method with testId kind but different formatted value AND different patternKind.
    const mismatchExtra: PomExtraClickMethodSpec = {
      kind: "click",
      name: "clickMismatch",
      selector: { kind: "testId", testId: createPomStringPattern("other-${key}", "parameterized", ["key"]) },
      parameters: [],
    };

    const componentHierarchyMap = new Map<string, IComponentDependencies>([
      ["M", deps(dataTestIdSet, { pomExtraMethods: [mismatchExtra] })],
    ]);

    const code = generateTestIdsModule(componentHierarchyMap, new Map());
    expect(code).toContain("\"clickPrimary\"");
    expect(code).not.toContain("\"clickMismatch\"");
  });

  it("dedupes generatedActionNames when an extra method name equals the primary action name", () => {
    const primarySelector = createPomStringPattern("dup", "static", []);
    const dataTestIdSet = new Set<IDataTestId>([
      entry({
        selectorValue: primarySelector,
        pom: pom({
          methodName: "Dup",
          selector: primarySelector,
          generatedActionName: "clickDup",
          generatedPropertyName: "DupButton",
        }),
      }),
    ]);
    // Extra method with the SAME name as the primary -> should be deduped out of generatedActionNames.
    const dupExtra: PomExtraClickMethodSpec = {
      kind: "click",
      name: "clickDup",
      selector: { kind: "testId", testId: primarySelector },
      parameters: [],
    };

    const componentHierarchyMap = new Map<string, IComponentDependencies>([
      ["DupView", deps(dataTestIdSet, { pomExtraMethods: [dupExtra], isView: true })],
    ]);

    const code = generateTestIdsModule(componentHierarchyMap, new Map());

    // Parse the generated pomManifest object to inspect generatedActionNames precisely.
    const match = code.match(/export const pomManifest = (\{[\s\S]*?\}) as const/);
    expect(match).not.toBeNull();
    const pomManifest = JSON.parse(match![1]);
    const entries = pomManifest.DupView.entries;
    expect(entries).toHaveLength(1);
    // generatedActionName field retains the primary name; generatedActionNames array dedupes to a single entry.
    expect(entries[0].generatedActionName).toBe("clickDup");
    expect(entries[0].generatedActionNames).toEqual(["clickDup"]);
  });

  it("emitPrimary is false when pom.emitPrimary is false", () => {
    const primarySelector = createPomStringPattern("hidden", "static", []);
    const dataTestIdSet = new Set<IDataTestId>([
      entry({
        selectorValue: primarySelector,
        pom: pom({
          methodName: "Hidden",
          selector: primarySelector,
          generatedActionName: "clickHidden",
          generatedPropertyName: "HiddenButton",
          emitPrimary: false,
        }),
      }),
    ]);

    const componentHierarchyMap = new Map<string, IComponentDependencies>([
      ["Hidden", deps(dataTestIdSet, { isView: true })],
    ]);

    const code = generateTestIdsModule(componentHierarchyMap, new Map());
    expect(code).toContain("\"emitPrimary\": false");
  });

  it("sorts multiple matching extra action names alphabetically (line 72 sort comparator)", () => {
    const primarySelector = createPomStringPattern("multi", "static", []);
    const dataTestIdSet = new Set<IDataTestId>([
      entry({
        selectorValue: primarySelector,
        pom: pom({
          methodName: "Multi",
          selector: primarySelector,
          generatedActionName: "clickMulti",
          generatedPropertyName: "MultiButton",
        }),
      }),
    ]);
    // Two extra methods both matching the primary selector -> sort comparator runs.
    const extras: PomExtraClickMethodSpec[] = [
      { kind: "click", name: "zetaExtra", selector: { kind: "testId", testId: primarySelector }, parameters: [] },
      { kind: "click", name: "alphaExtra", selector: { kind: "testId", testId: primarySelector }, parameters: [] },
    ];

    const componentHierarchyMap = new Map<string, IComponentDependencies>([
      ["MultiView", deps(dataTestIdSet, { pomExtraMethods: extras, isView: true })],
    ]);

    const code = generateTestIdsModule(componentHierarchyMap, new Map());
    const match = code.match(/export const pomManifest = (\{[\s\S]*?\}) as const/);
    expect(match).not.toBeNull();
    const pomManifest = JSON.parse(match![1]);
    const names = pomManifest.MultiView.entries[0].generatedActionNames;
    // Primary action first, then sorted matching extras (deduped against the primary).
    expect(names).toEqual(["clickMulti", "alphaExtra", "zetaExtra"]);
  });

  it("sorts multiple testIds within a component alphabetically (line 121 sort comparator)", () => {
    const zetaSelector = createPomStringPattern("zeta-id", "static", []);
    const alphaSelector = createPomStringPattern("alpha-id", "static", []);
    const dataTestIdSet = new Set<IDataTestId>([
      entry({
        selectorValue: zetaSelector,
        pom: pom({ methodName: "ZetaId", selector: zetaSelector, generatedActionName: "clickZetaId", generatedPropertyName: "ZetaIdButton" }),
      }),
      entry({
        selectorValue: alphaSelector,
        pom: pom({ methodName: "AlphaId", selector: alphaSelector, generatedActionName: "clickAlphaId", generatedPropertyName: "AlphaIdButton" }),
      }),
    ]);

    const componentHierarchyMap = new Map<string, IComponentDependencies>([
      ["MultiIds", deps(dataTestIdSet, { isView: true })],
    ]);

    const code = generateTestIdsModule(componentHierarchyMap, new Map());
    const match = code.match(/export const pomManifest = (\{[\s\S]*?\}) as const/);
    expect(match).not.toBeNull();
    const pomManifest = JSON.parse(match![1]);
    const entries = pomManifest.MultiIds.entries;
    // Entries sorted by testId formatted: alpha-id before zeta-id.
    expect(entries.map((e: { testId: string }) => e.testId)).toEqual(["alpha-id", "zeta-id"]);
  });
});
