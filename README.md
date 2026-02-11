# @immense/vue-pom-generator

Vite plugin for Vue 3 apps that:

- Injects stable `data-testid` attributes into interactive elements during Vue template compilation
- Generates Page Object Model (POM) classes for views/components (Playwright-focused by default)

Why you might want it:

- **Less brittle end-to-end tests**: selectors stay stable even if markup/layout shifts.
- **Less boilerplate**: POM generation keeps tests readable and centralized.
- **Not just testing**: a consistent attribute can also help analytics/user-tracking tooling and ad-hoc automation.

## Install (npm)

Package: `@immense/vue-pom-generator`

```sh
npm install @immense/vue-pom-generator
```

## Usage

Exported entrypoint: `createVuePomGeneratorPlugins()`.

## Configuration

`createVuePomGeneratorPlugins(options)` accepts a `VuePomGeneratorPluginOptions` object, grouped into:

- `injection`: how `data-testid` (or your chosen attribute) is derived/injected
- `generation`: how Page Object Models (POMs) and Playwright helpers are generated

The generator emits an aggregated output under `generation.outDir` (default `tests/playwright/generated`):

- `tests/playwright/generated/page-object-models.g.ts` (generated; do not edit)
- `tests/playwright/generated/index.ts` (generated stable barrel)

If `generation.playwright.fixtures` is enabled, it also emits:

- `tests/playwright/generated/fixtures.g.ts` (generated; do not edit)

### Vite config example

```ts
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { createVuePomGeneratorPlugins } from "@immense/vue-pom-generator";

export default defineConfig(() => {
  const vueOptions = {
    script: { defineModel: true, propsDestructure: true },
  };

  return {
    plugins: [
      ...createVuePomGeneratorPlugins({
        vueOptions,
        logging: { verbosity: "info" },

        injection: {
          // Attribute to inject/read as the test id (default: data-testid)
          attribute: "data-testid",

          // Used to classify Vue files as "views" vs components (default: src/views)
          viewsDir: "src/views",

          // Directories to scan for .vue files when building the POM library (default: ["src"])
          // For Nuxt, you might want ["app", "components", "pages", "layouts"]
          scanDirs: ["src"],

          // Optional: wrapper semantics for design-system components
          nativeWrappers: {
            MyButton: { role: "button" },
            MyInput: { role: "input" },
          },

          // Optional: opt specific components out of injection
          excludeComponents: ["MyButton"],

          // Optional: preserve/overwrite/error when an author already set the attribute
          existingIdBehavior: "preserve",
        },

        generation: {
          // Default: ["ts"]
          emit: ["ts", "csharp"],

          // C# specific configuration
          csharp: {
            // The namespace for generated C# classes (default: Playwright.Generated)
            namespace: "MyProject.Tests.Generated",
          },

          // Default: tests/playwright/generated
          outDir: "tests/playwright/generated",

          // Controls how to handle duplicate generated member names within a single POM class.
          // - "error": fail compilation
          // - "warn": warn and suffix
          // - "suffix": suffix silently (default)
          nameCollisionBehavior: "suffix",

          // Enable router introspection. When provided, router-aware POM helpers are generated.
          router: {
            // For standard Vue apps:
            entry: "src/router.ts",
            // For Nuxt apps (file-based routing):
            // type: "nuxt"
          },

          playwright: {
            fixtures: true,
            customPoms: {
              // Default: tests/playwright/pom/custom
              dir: "tests/playwright/pom/custom",
              importAliases: { MyCheckBox: "CheckboxWidget" },
              attachments: [
                {
                  className: "ConfirmationModal",
                  propertyName: "confirmationModal",
                  attachWhenUsesComponents: ["Page"],
                },
              ],
            },
          },
        },
      }),
      vue(vueOptions),
    ],
  };
});
```

Notes:

- **Injection is enabled by plugin inclusion** (there is no longer an `injection.enabled` flag).
- **Generation is enabled by default** and can be disabled via `generation: false`.
- **Router-aware POM helpers are enabled** when `generation.router.entry` is provided (the generator will introspect your router).

### `generation.router`

Controls router introspection for `:to` analysis and navigation helper generation.

- `entry: string`: For standard Vue apps, where router introspection loads your Vue Router definition from. This file must export a **default router factory function** (e.g. `export default makeRouter`).
- `type: "vue-router" | "nuxt"`: The introspection provider. Defaults to `"vue-router"`. Use `"nuxt"` for file-based routing discovery (e.g. `app/pages` or `pages`).

### `generation.playwright.fixtures: boolean | string | { outDir?: string }`

When enabled, the generator emits a concrete, strongly typed Playwright fixture module so tests can do:

- `test("...", async ({ preferencesPage }) => { ... })`

Forms:

- `true`: enable with defaults
- `"path"`: enable and write under this directory (or file, if it ends in `.ts`/`.tsx`/`.mts`/`.cts`)
- `{ outDir }`: enable and write fixture outputs under a custom directory

Defaults:

- when `true`: writes `fixtures.g.ts` alongside generated POMs (under `generation.outDir`)

### Vite config example

- `nativeWrappers` describes common wrapper components (e.g. design-system buttons/inputs)
- `customPom` groups handwritten helper wiring and conditional attachments
- `testIdAttribute` lets you use a different attribute name (e.g. `data-qa`, `data-cy`)

### Notes for Playwright users

This package emits Playwright-oriented helpers (e.g. `page.getByTestId(...)`).

If you change Playwright's `testIdAttribute`, make sure the app actually renders the same attribute.

### Migration helper: `injection.existingIdBehavior`

When cleaning up a codebase that already has a mix of manually-authored test ids and generated ones:

- `"preserve"` (default): leave author-provided ids untouched
- `"overwrite"`: replace existing ids with generated ids
- `"error"`: throw when an existing id is detected (useful for incremental cleanup)

## Sequence diagram

See: [`sequence-diagram.md`](./sequence-diagram.md)
