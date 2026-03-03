# PomElement Wrapper Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace raw `PwLocator` getters with a `PomElement` wrapper class that exposes fluent assertion methods (`assertVisible()`, `assertAttribute()`, `waitFor()`, etc.) while keeping a `.raw` escape hatch for full Playwright access.

**Architecture:** A new `PomElement` class wraps `PwLocator` and adds assertion helpers. `generateGetElementByDataTestId` in `method-generation.ts` gains an `exposeGetters` flag that switches between `return this.locatorByTestId(...)` (legacy) and `return new PomElement(...)` (default new). `PomElement.ts` is copied to the generated runtime dir alongside `Pointer.ts` and re-exported from `page-object-models.g.ts`. `GenerateFilesOptions` gets an `exposeGetters` field; default is `"pom-element"`.

**Tech Stack:** TypeScript, Vitest, `@playwright/test` (expect API), existing `method-generation.ts` / `class-generation/index.ts` codegen pipeline.

---

### Task 1: Create `PomElement.ts` with core assertion methods

**Files:**
- Create: `class-generation/PomElement.ts`

**Step 1: Write the failing test**

Add to `tests/class-generation-coverage.test.ts` — a new `describe` block at the bottom:

```ts
describe("PomElement wrapper", () => {
  it("is re-exported from the generated page-object-models.g.ts", async () => {
    const tempRoot = makeTempRoot("vue-pom-element-");
    try {
      const basePagePath = path.join(tempRoot, "BasePage.ts");
      writeMinimalBasePage(basePagePath);
      const componentHierarchyMap = new Map<string, IComponentDependencies>([
        ["UsersPage", makeDeps({
          filePath: path.join(tempRoot, "src", "views", "UsersPage.vue"),
          isView: true,
          dataTestIdSet: new Set([{ value: "UsersPage-Save-button" }]),
        })],
      ]);
      const outDir = path.join(tempRoot, "pom");
      await generateFiles(componentHierarchyMap, new Map(), basePagePath, {
        outDir,
        projectRoot: tempRoot,
      });
      const pomFile = path.join(outDir, "page-object-models.g.ts");
      const content = fs.readFileSync(pomFile, "utf8");
      // PomElement must be exported from the aggregated output
      expect(content).toContain("export * from");
      expect(content).toContain("PomElement");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("getters emit `new PomElement(...)` by default", async () => {
    const tempRoot = makeTempRoot("vue-pom-element-getter-");
    try {
      const basePagePath = path.join(tempRoot, "BasePage.ts");
      writeMinimalBasePage(basePagePath);
      const componentHierarchyMap = new Map<string, IComponentDependencies>([
        ["UsersPage", makeDeps({
          filePath: path.join(tempRoot, "src", "views", "UsersPage.vue"),
          isView: true,
          dataTestIdSet: new Set([{ value: "UsersPage-Save-button" }]),
        })],
      ]);
      const outDir = path.join(tempRoot, "pom");
      await generateFiles(componentHierarchyMap, new Map(), basePagePath, {
        outDir,
        projectRoot: tempRoot,
      });
      const content = fs.readFileSync(path.join(outDir, "page-object-models.g.ts"), "utf8");
      expect(content).toContain("new PomElement(");
      expect(content).not.toContain("return this.locatorByTestId(\"UsersPage-Save-button\")");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("exposeGetters: 'locator' keeps legacy raw locator return", async () => {
    const tempRoot = makeTempRoot("vue-pom-locator-getter-");
    try {
      const basePagePath = path.join(tempRoot, "BasePage.ts");
      writeMinimalBasePage(basePagePath);
      const componentHierarchyMap = new Map<string, IComponentDependencies>([
        ["UsersPage", makeDeps({
          filePath: path.join(tempRoot, "src", "views", "UsersPage.vue"),
          isView: true,
          dataTestIdSet: new Set([{ value: "UsersPage-Save-button" }]),
        })],
      ]);
      const outDir = path.join(tempRoot, "pom");
      await generateFiles(componentHierarchyMap, new Map(), basePagePath, {
        outDir,
        projectRoot: tempRoot,
        exposeGetters: "locator",
      });
      const content = fs.readFileSync(path.join(outDir, "page-object-models.g.ts"), "utf8");
      expect(content).not.toContain("new PomElement(");
      expect(content).toContain("return this.locatorByTestId(\"UsersPage-Save-button\")");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
cd /path/to/vue-pom-generator
npm test -- --reporter=verbose tests/class-generation-coverage.test.ts
```

Expected: 3 new tests FAIL — `PomElement` doesn't exist yet.

**Step 3: Create `class-generation/PomElement.ts`**

```ts
import type { PwLocator } from "./playwright-types";
import { expect } from "@playwright/test";

/**
 * A thin wrapper around a Playwright Locator that adds fluent assertion helpers.
 *
 * Usage:
 *   await pom.SaveButton.assertVisible();
 *   await pom.ToggleButton.assertAttribute("aria-pressed", "true");
 *   await pom.NameInput.assertValue("Acme Corp");
 *
 * Escape hatch: use `.raw` to access the underlying PwLocator for anything
 * not covered by PomElement helpers.
 */
export class PomElement {
  constructor(private readonly locator: PwLocator) {}

  /** Underlying Playwright locator — use when PomElement helpers don't cover your case. */
  get raw(): PwLocator {
    return this.locator;
  }

  async assertVisible(): Promise<this> {
    await expect(this.locator).toBeVisible();
    return this;
  }

  async assertHidden(): Promise<this> {
    await expect(this.locator).toBeHidden();
    return this;
  }

  async assertText(text: string | RegExp): Promise<this> {
    await expect(this.locator).toHaveText(text);
    return this;
  }

  async assertContainsText(text: string | RegExp): Promise<this> {
    await expect(this.locator).toContainText(text);
    return this;
  }

  async assertAttribute(attr: string, value: string | RegExp): Promise<this> {
    await expect(this.locator).toHaveAttribute(attr, value);
    return this;
  }

  async assertValue(value: string | RegExp): Promise<this> {
    await expect(this.locator).toHaveValue(value);
    return this;
  }

  async assertEnabled(): Promise<this> {
    await expect(this.locator).toBeEnabled();
    return this;
  }

  async assertDisabled(): Promise<this> {
    await expect(this.locator).toBeDisabled();
    return this;
  }

  async waitFor(options?: Parameters<PwLocator["waitFor"]>[0]): Promise<this> {
    await this.locator.waitFor(options);
    return this;
  }

  // Convenience proxies for common read operations.
  getAttribute(attr: string) { return this.locator.getAttribute(attr); }
  innerText() { return this.locator.innerText(); }
  inputValue() { return this.locator.inputValue(); }
  count() { return this.locator.count(); }
  isVisible() { return this.locator.isVisible(); }
  isEnabled() { return this.locator.isEnabled(); }
  first() { return new PomElement(this.locator.first()); }
  nth(index: number) { return new PomElement(this.locator.nth(index)); }
}
```

**Step 4: Run tests — they still fail** (the generator doesn't use PomElement yet). Expected: same 3 FAILs. This is correct — continue to Task 2.

---

### Task 2: Wire `exposeGetters` option through the codegen pipeline

**Files:**
- Modify: `class-generation/index.ts` — `GenerateFilesOptions` interface (~line 268) and `generateAggregatedContent` internal options (~line 1160)
- Modify: `method-generation.ts` — `generateGetElementByDataTestId` (~line 177) and `generateViewObjectModelMethodContent` (~line 281)

**Step 1: Add `exposeGetters` to `GenerateFilesOptions`**

In `class-generation/index.ts`, after the `emitLanguages` field (~line 333), add:

```ts
/**
 * Controls what element getter properties return.
 * - `"pom-element"` (default) — returns `PomElement` with fluent assertion helpers.
 * - `"locator"` — returns raw `PwLocator` (legacy / backward-compat).
 */
exposeGetters?: "pom-element" | "locator";
```

**Step 2: Thread the option to internal generation**

Find the internal `GenerateContentOptions` interface (~line 352). Add `exposeGetters?: "pom-element" | "locator"` to it.

Find where `GenerateFilesOptions` is destructured to build `GenerateContentOptions` (~line 387–430). Extract `exposeGetters` and pass it through.

Find `generateAggregatedContent`'s options param (~line 1160). Add `exposeGetters?: GenerateFilesOptions["exposeGetters"]` and thread it down into `generateClassContent`.

**Step 3: Add `exposeGetters` param to `generateViewObjectModelMethodContent`**

In `method-generation.ts`, change the signature of `generateViewObjectModelMethodContent` to accept an options object:

```ts
export function generateViewObjectModelMethodContent(
  targetPageObjectModelClass: string | undefined,
  methodName: string,
  nativeRole: string,
  formattedDataTestId: string,
  alternateFormattedDataTestIds: string[] | undefined,
  getterNameOverride: string | undefined,
  params: Record<string, string>,
  options?: { exposeGetters?: "pom-element" | "locator" },  // ADD THIS
) {
```

Pass `options` into `generateGetElementByDataTestId`.

**Step 4: Change `generateGetElementByDataTestId` to wrap with PomElement**

Change the function signature to accept `options?: { exposeGetters?: "pom-element" | "locator" }`, then change the three return sites:

```ts
// Before (all three return sites):
return `${INDENT}get ${finalPropertyName}() {\n`
  + `${INDENT2}return this.locatorByTestId("${formattedDataTestId}");\n`
  + `${INDENT}}\n\n`;

// After — when exposeGetters !== "locator":
const usePomElement = (options?.exposeGetters ?? "pom-element") !== "locator";
// ...
return `${INDENT}get ${finalPropertyName}() {\n`
  + (usePomElement
      ? `${INDENT2}return new PomElement(this.locatorByTestId("${formattedDataTestId}"));\n`
      : `${INDENT2}return this.locatorByTestId("${formattedDataTestId}");\n`)
  + `${INDENT}}\n\n`;
```

Apply the same pattern to the keyed and alternate-locator return sites.

**Step 5: Run tests**

```bash
npm test -- --reporter=verbose tests/class-generation-coverage.test.ts
```

Expected: "getters emit new PomElement(...) by default" and "exposeGetters: 'locator' keeps legacy" tests PASS. "is re-exported from page-object-models.g.ts" still FAILS — Task 3 fixes that.

---

### Task 3: Copy `PomElement.ts` to the generated runtime dir and re-export it

**Files:**
- Modify: `class-generation/index.ts` — runtime file copy list (~line 1491) and imports block (~line 1196)

**Step 1: Add `PomElement.ts` to the runtime files list**

In the `runtimeFiles` array (~line 1494), add after the `Pointer.ts` entry:

```ts
{
  filePath: path.join(runtimeClassGenAbs, "PomElement.ts"),
  content: readText(
    fileURLToPath(new URL("../class-generation/PomElement.ts", import.meta.url)),
    "PomElement.ts",
  ),
},
```

**Step 2: Add the import and re-export to the aggregated file header**

In the imports block (~line 1196), add after the `Pointer` import/export lines:

```ts
imports.push(`import { PomElement } from "${runtimeClassGenRel}/PomElement";`);
imports.push(`export * from "${runtimeClassGenRel}/PomElement";`);
```

**Step 3: Run all tests**

```bash
npm test
```

Expected: all 3 new tests PASS, all prior tests still PASS (total count increases by 3). If any pre-existing test fails, investigate before continuing.

**Step 4: Commit**

```bash
git add class-generation/PomElement.ts method-generation.ts class-generation/index.ts tests/class-generation-coverage.test.ts
git commit -m "feat: add PomElement wrapper with fluent assertions, exposeGetters option

- New class-generation/PomElement.ts wraps PwLocator with assertVisible(),
  assertHidden(), assertText(), assertContainsText(), assertAttribute(),
  assertValue(), assertEnabled(), assertDisabled(), waitFor(), and .raw
- Getters in generated POM classes now return PomElement by default
- exposeGetters: 'locator' preserves legacy raw PwLocator return for
  backward compatibility

Generated with Claude Code
via Happy (https://happy.engineering)

Co-Authored-By: Claude <noreply@anthropic.com>
Co-Authored-By: Happy <yesreply@happy.engineering>"
```

---

### Task 4: Update `BasePage.keyedLocators` to return `PomElement`

**Files:**
- Modify: `class-generation/BasePage.ts:252-263`

**Step 1: Write the failing test**

Add a new `it` block in the "PomElement wrapper" describe in `tests/class-generation-coverage.test.ts`:

```ts
it("keyed getters emit PomElement wrappers by default", async () => {
  const tempRoot = makeTempRoot("vue-pom-keyed-element-");
  try {
    const basePagePath = path.join(tempRoot, "BasePage.ts");
    writeMinimalBasePage(basePagePath);
    const dt: IDataTestId = {
      value: "list-item-${key}",
      pom: {
        nativeRole: "button",
        methodName: "ListItemByKey",
        formattedDataTestId: "list-item-${key}",
        params: { key: "string" },
      },
    };
    const componentHierarchyMap = new Map<string, IComponentDependencies>([
      ["ListPage", makeDeps({
        filePath: path.join(tempRoot, "src", "views", "ListPage.vue"),
        isView: true,
        dataTestIdSet: new Set([dt]),
      })],
    ]);
    const outDir = path.join(tempRoot, "pom");
    await generateFiles(componentHierarchyMap, new Map(), basePagePath, {
      outDir,
      projectRoot: tempRoot,
    });
    const content = fs.readFileSync(path.join(outDir, "page-object-models.g.ts"), "utf8");
    // Keyed getter must also wrap in PomElement
    expect(content).toContain("new PomElement(this.locatorByTestId");
    expect(content).toContain("ListItemButton");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
```

**Step 2: Run test to verify it fails**

```bash
npm test -- --reporter=verbose tests/class-generation-coverage.test.ts
```

Expected: new keyed test FAILS.

**Step 3: Update `BasePage.keyedLocators`**

In `class-generation/BasePage.ts` at line 252, change the signature and body to return `PomElement`:

```ts
// Before
protected keyedLocators<TKey extends string>(getLocator: (key: TKey) => PwLocator): Record<TKey, PwLocator> {
  const handler: ProxyHandler<object> = {
    get: (_t, prop) => {
      if (prop === "then" || typeof prop === "symbol") return undefined;
      return getLocator(String(prop) as TKey);
    },
  };
  return new Proxy({}, handler) as Record<TKey, PwLocator>;
}
```

```ts
// After
protected keyedLocators<TKey extends string>(getLocator: (key: TKey) => PomElement): Record<TKey, PomElement> {
  const handler: ProxyHandler<object> = {
    get: (_t, prop) => {
      if (prop === "then" || typeof prop === "symbol") return undefined;
      return getLocator(String(prop) as TKey);
    },
  };
  return new Proxy({}, handler) as Record<TKey, PomElement>;
}
```

Add the import at the top of `BasePage.ts`:
```ts
import { PomElement } from "./PomElement";
```

Also update the keyed getter emit in `generateGetElementByDataTestId` (`method-generation.ts` ~line 201) to wrap with `PomElement`:

```ts
// Before
return `${INDENT}get ${keyedPropertyName}() {\n`
  + `${INDENT2}return this.keyedLocators((key: ${keyType}) => this.locatorByTestId(\`${formattedDataTestId}\`));\n`
  + `${INDENT}}\n\n`;

// After (when exposeGetters !== "locator")
const usePomElement = (options?.exposeGetters ?? "pom-element") !== "locator";
return `${INDENT}get ${keyedPropertyName}() {\n`
  + (usePomElement
    ? `${INDENT2}return this.keyedLocators((key: ${keyType}) => new PomElement(this.locatorByTestId(\`${formattedDataTestId}\`)));\n`
    : `${INDENT2}return this.keyedLocators((key: ${keyType}) => this.locatorByTestId(\`${formattedDataTestId}\`));\n`)
  + `${INDENT}}\n\n`;
```

**Step 4: Run all tests**

```bash
npm test
```

Expected: all tests PASS including the new keyed test.

**Step 5: Commit**

```bash
git add class-generation/BasePage.ts method-generation.ts tests/class-generation-coverage.test.ts
git commit -m "feat: keyed locator getters return PomElement wrappers

Co-Authored-By: Claude <noreply@anthropic.com>
Co-Authored-By: Happy <yesreply@happy.engineering>"
```

---

### Task 5: Bump version and publish

**Files:**
- Modify: `package.json`

**Step 1: Run full test suite and typecheck**

```bash
npm test && npm run typecheck
```

Expected: all tests PASS, no type errors.

**Step 2: Bump version**

In `package.json`, change `"version": "1.0.14"` → `"1.0.15"`.

> Note: 1.0.14 is the animated-cursor release (Pointer.ts). This PomElement feature is 1.0.15.

**Step 3: Commit and push**

```bash
git add package.json
git commit -m "chore: bump version to 1.0.15 for PomElement wrapper release

Co-Authored-By: Claude <noreply@anthropic.com>
Co-Authored-By: Happy <yesreply@happy.engineering>"
git push
```

**Step 4: Verify CI publishes**

Watch the GitHub Actions run. Expected: tests pass, `npm publish` succeeds, `1.0.15` appears on `npm view @immense/vue-pom-generator version`.

---

### Task 6: Migrate Ayla's C# tests (no-op — C# unchanged)

C# POM generation emits `ILocator` properties unchanged. The `PomElement` wrapper is TypeScript-only. **No Ayla migration needed for C# tests.**

If/when TypeScript POMs are used in Ayla in the future, existing code using raw `PwLocator` getters should either:
- Use `pom.SomeButton.raw` for direct Playwright access
- Or migrate to `pom.SomeButton.assertVisible()` etc.

---

## Notes

- `exposeGetters: "locator"` gives any existing project a zero-migration path
- The `or()`-combined alternate-locator getter also needs the PomElement wrap — handled in Task 2, Step 4 (the alternates code path at `method-generation.ts:215`)
- `BasePage.ts` is user-supplied; the `import { PomElement }` line added in Task 4 means user-supplied `BasePage.ts` files need this import too. **This is a breaking change for users with custom BasePage.** Mitigation: either add the import in the generated runtime copy (the file copied to `_pom-runtime/class-generation/BasePage.ts`) rather than modifying the template file, or check if BasePage already imports PomElement before adding.
