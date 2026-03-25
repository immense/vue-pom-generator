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

Exported entrypoints:

- `createVuePomGeneratorPlugins()`
- `vuePomGenerator()` (alias)
- `defineVuePomGeneratorConfig()` (typed config helper)
- `@immense/vue-pom-generator/eslint` (ESLint rules for cleanup/enforcement)

## Configuration

`createVuePomGeneratorPlugins(options)` accepts a `VuePomGeneratorPluginOptions` object, grouped into:

- `injection`: how `data-testid` (or your chosen attribute) is derived/injected
- `generation`: how Page Object Models (POMs) and Playwright helpers are generated

The generator emits an aggregated output under `generation.outDir` (default `tests/playwright/__generated__`):

- `tests/playwright/__generated__/page-object-models.g.ts` (generated; do not edit)
- `tests/playwright/__generated__/index.ts` (generated stable barrel)
- managed `.gitattributes` files only when you emit outside `__generated__`

If `generation.playwright.fixtures` is enabled, it also emits:

- `tests/playwright/__generated__/fixtures.g.ts` (generated; do not edit)

Generated fixtures automatically prefer matching handwritten override classes from
`tests/playwright/pom/overrides/<ClassName>.ts` (or the sibling `overrides/` directory next to
your configured `generation.playwright.customPoms.dir`).

### Vite config example

```ts
import { defineConfig } from "vite";
import { defineVuePomGeneratorConfig, vuePomGenerator } from "@immense/vue-pom-generator";

export default defineConfig(() => {
  const vueOptions = {
    script: { defineModel: true, propsDestructure: true },
  };

  const pomConfig = defineVuePomGeneratorConfig({
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

      // Optional: extra directories to search when inferring wrapper-component roles for
      // components that live outside scanDirs (for example a sibling shared UI package)
      wrapperSearchRoots: ["../shared/ui/src/components"],

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

      // Default: tests/playwright/__generated__
      outDir: "tests/playwright/__generated__",

      // Controls how to handle duplicate generated member names within a single POM class.
      // - "error": fail compilation
      // - "warn": warn and suffix
      // - "suffix": suffix silently (default)
      nameCollisionBehavior: "suffix",

      // Enable router introspection. When provided, router-aware POM helpers are generated.
      router: {
        // For standard Vue apps:
        entry: "src/router.ts",
        moduleShims: {
          "@/config/app-insights": {
            getAppInsights: () => null,
          },
          "@/store/pinia/app-alert-store": ["useAppAlertsStore"],
        },
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
  });

  return {
    plugins: [...vuePomGenerator(pomConfig)],
  };
});
```

Notes:

- `vuePomGenerator(...)` wires `@vitejs/plugin-vue` internally by default for standard Vue apps.
- Do not pass `vue()` into `createVuePomGeneratorPlugins(...)`; pass Vue plugin options via `vueOptions`.
- When the app should own `vue()` explicitly, set `vuePluginOwnership: "external"` and add `vue()` separately in your Vite config.

- **Injection is enabled by plugin inclusion** (there is no longer an `injection.enabled` flag).
- **Generation is enabled by default** and can be disabled via `generation: false`.
- **Router-aware POM helpers are enabled** when `generation.router.entry` is provided (the generator will introspect your router).

### External Vue plugin ownership

If your app should own the core Vue Vite plugin explicitly, add `vue()` yourself and let this package patch the resolved plugin:

```ts
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";
import { defineVuePomGeneratorConfig, vuePomGenerator } from "@immense/vue-pom-generator";

const pomConfig = defineVuePomGeneratorConfig({
  vuePluginOwnership: "external",
});

export default defineConfig({
  plugins: [
    vue(),
    ...vuePomGenerator(pomConfig),
  ],
});
```

### `generation.router`

Controls router introspection for `:to` analysis and navigation helper generation.

- `entry: string`: For standard Vue apps, where router introspection loads your Vue Router definition from. This file must export a **default router factory function** (e.g. `export default makeRouter`).
- `type: "vue-router" | "nuxt"`: The introspection provider. Defaults to `"vue-router"`. Use `"nuxt"` for file-based routing discovery (e.g. `app/pages` or `pages`).
- `moduleShims: Record<string, string[] | Record<string, fn>>`: Optional module-source -> shim definition map used only while introspecting the router.
- Use `string[]` for no-op exported functions (e.g. `["useAppAlertsStore"]`).
- Use `Record<string, fn>` for explicit exported function implementations (e.g. `{ getAppInsights: () => null }`).

### `generation.playwright.fixtures: boolean | string | { outDir?: string }`

When enabled, the generator emits a concrete, strongly typed Playwright fixture module so tests can do:

- `test("...", async ({ preferencesPage }) => { ... })`

Forms:

- `true`: enable with defaults
- `"path"`: enable and write under this directory (or file, if it ends in `.ts`/`.tsx`/`.mts`/`.cts`)
- `{ outDir }`: enable and write fixture outputs under a custom directory

Defaults:

- when `true`: writes `fixtures.g.ts` alongside generated POMs (under `generation.outDir`)

Convention:

- if `tests/playwright/pom/overrides/<ClassName>.ts` exists, the generated fixture for that page/component
  instantiates the override class instead of the raw generated `Pom.<ClassName>`
- the override directory is inferred as the sibling `overrides/` directory next to
  `generation.playwright.customPoms.dir`

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

When you want CI/builds to fail on explicit test ids, pair `existingIdBehavior: "error"` with the ESLint cleanup rule exported from `@immense/vue-pom-generator/eslint`.

### ESLint cleanup rule: remove existing test-id attributes

Use the `remove-existing-test-id-attributes` rule to strip explicit test-id usage from `.vue` files before or while enforcing `existingIdBehavior: "error"`.

The fixer handles both template attributes like `data-testid="save-button"` and object-literal keys such as `inputAttr: { 'data-testid': 'save-button' }` inside Vue SFC expressions/scripts.

Add this to your ESLint flat-config file, typically `eslint.config.ts` (or `eslint.config.js` / `eslint.config.mjs` at the project root):

```ts
// eslint.config.ts (project root)
import vueParser from "vue-eslint-parser";
import { plugin as vuePomGeneratorEslint } from "@immense/vue-pom-generator/eslint";

export default [
  {
    files: ["**/*.vue"],
    languageOptions: {
      parser: vueParser,
      ecmaVersion: 2022,
      sourceType: "module",
    },
    plugins: {
      "@immense/vue-pom-generator": vuePomGeneratorEslint,
    },
    rules: {
      "@immense/vue-pom-generator/remove-existing-test-id-attributes": "error",
    },
  },
];
```

Then run ESLint with `--fix` once to remove legacy attributes across the project. After cleanup, keep the rule enabled in CI and set `injection.existingIdBehavior: "error"` so both linting and compilation fail fast when explicit ids sneak back in.

If you use a custom attribute instead of `data-testid`, configure the rule with an option:

In that same `eslint.config.ts` file:

```ts
// inside eslint.config.ts
const rules = {
  "@immense/vue-pom-generator/remove-existing-test-id-attributes": ["error", { attribute: "data-qa" }],
};
```

## Sequence diagram

See: [`sequence-diagram.md`](./sequence-diagram.md)
