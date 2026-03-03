# PomElement Wrapper Design

**Date:** 2026-03-03
**Status:** Approved — pending implementation
**Scope:** Post-1.0.14. Not part of the animated cursor release.

---

## Problem

The generator currently emits raw `PwLocator` getters alongside action methods:

```ts
// Raw getter — bypasses Pointer/animation entirely
get SubmitButton() { return this.locatorByTestId("submit-button"); }

// Action method — routes through BasePage.clickByTestId → Pointer
async clickSubmitButton(wait = true) { await this.clickByTestId("submit-button", "", wait); }
```

Tests can bypass animation by calling `pom.SubmitButton.click()` directly. Assertion patterns also
use raw Playwright locators (`pom.SomeButton.waitFor(...)`, `pom.SomeButton.getAttribute(...)`),
which works but exposes Playwright's entire `Locator` API surface rather than a curated interface.

---

## Desired API

Getters return a `PomElement` wrapper with fluent assertion methods:

```ts
await pom.SubmitButton.assertVisible();
await pom.PageSizeSelectionButton.assertAttribute("aria-pressed", "true");
await pom.ProfileNewUiToggle.assertVisible();
await pom.SubmitButton.waitFor({ state: "visible" });
```

Fluent chains stay readable:

```ts
await pom.ProfileNewUiToggle
  .waitFor({ state: "visible" })
  .then(() => pom.clickProfileNewUiToggle());
```

---

## Design

### `PomElement` class (new, in `class-generation/PomElement.ts`)

```ts
import type { PwLocator } from "./playwright-types";
import { expect } from "@playwright/test";

export class PomElement {
  constructor(private readonly locator: PwLocator) {}

  /** Raw Playwright locator — escape hatch for cases not covered by PomElement helpers. */
  get raw(): PwLocator { return this.locator; }

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

  async assertAttribute(attr: string, value: string | RegExp): Promise<this> {
    await expect(this.locator).toHaveAttribute(attr, value);
    return this;
  }

  async assertValue(value: string): Promise<this> {
    await expect(this.locator).toHaveValue(value);
    return this;
  }

  async waitFor(options?: Parameters<PwLocator["waitFor"]>[0]): Promise<this> {
    await this.locator.waitFor(options);
    return this;
  }

  // Convenience proxies for the most common read operations.
  getAttribute(attr: string) { return this.locator.getAttribute(attr); }
  innerText() { return this.locator.innerText(); }
  inputValue() { return this.locator.inputValue(); }
  count() { return this.locator.count(); }
  isVisible() { return this.locator.isVisible(); }
  isEnabled() { return this.locator.isEnabled(); }
}
```

### Generator changes

`generateGetElementByDataTestId` in `method-generation.ts` changes from:

```ts
// Before
`    get ${propertyName}() {\n`
+ `        return this.locatorByTestId("${testId}");\n`
+ `    }\n`
```

to:

```ts
// After
`    get ${propertyName}() {\n`
+ `        return new PomElement(this.locatorByTestId("${testId}"));\n`
+ `    }\n`
```

`PomElement` is copied to the generated runtime dir (alongside `Pointer.ts`, `BasePage.ts`) and
re-exported from `page-object-models.g.ts`:

```ts
export * from "./class-generation/PomElement";
```

### Generator option: `exposeGetters`

```ts
interface GenerateFilesOptions {
  /**
   * Controls the type returned by element getter properties.
   * - "pom-element" (default) — returns PomElement with fluent assertion methods
   * - "locator" — returns raw PwLocator (legacy / backward-compat)
   */
  exposeGetters?: "pom-element" | "locator";
}
```

Default is `"pom-element"` for new projects. Existing users can opt out with `"locator"` to
preserve current behaviour during migration.

### Keyed getters

Keyed getters return a `Record<TKey, PomElement>` proxy instead of `Record<TKey, PwLocator>`:

```ts
get SaveButton() {
  return this.keyedLocators((key: string) =>
    new PomElement(this.locatorByTestId(`save-${key}`))
  );
}
// usage:
await pom.SaveButton["someKey"].assertVisible();
```

`BasePage.keyedLocators` signature is updated to accept a `PomElement`-returning callback.

---

## Migration path for Ayla's existing tests

Current pattern:
```cs
await pom.PageSizeSelectionButton.GetAttributeAsync("aria-pressed"); // C# — unaffected
await pom.ProfileNewUiToggleButton.WaitForAsync(...);               // C# — unaffected
```

C# generation is unchanged — C# POMs emit `ILocator` properties, not `PomElement`. The
`PomElement` wrapper is TypeScript-only.

TypeScript tests using raw getters need migration only if they call Playwright methods not
proxied by `PomElement` — the `.raw` escape hatch covers those cases without a rewrite.

---

## What is NOT in scope

- Making `click()` / `fill()` available on `PomElement` (action routing stays in BasePage methods)
- C# `PomElement` equivalent (C# tests use `ILocator` directly; this is TypeScript-only)
- Replacing the `Pointer`/animation layer (that's a separate concern)

---

## Open questions

- Should `PomElement` also expose a `.first` / `.nth(n)` for multi-element locators that return
  `PomElement`? Probably yes — defer to implementation.
- Should `assertVisible()` etc. accept Playwright `expect` options (timeout, message)? Yes, but
  keep the signature simple for now and add options in a follow-up.
