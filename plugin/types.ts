import type { Options as VuePluginOptions } from "@vitejs/plugin-vue";
import type { NativeWrappersMap } from "../utils";

export type ExistingIdBehavior = "preserve" | "overwrite" | "error";

/**
 * Controls what happens when the generator would emit duplicate POM member names within a single class.
 *
 * This typically occurs when multiple elements fall back to role-based naming (e.g. "Button") because
 * no semantic hint (click handler name, id/name, inner text, etc.) could be derived.
 */
export type PomNameCollisionBehavior = "error" | "warn" | "suffix";

export interface VuePomGeneratorPluginOptions {
  /** Options forwarded to @vitejs/plugin-vue */
  vueOptions?: VuePluginOptions;

  /**
   * Logging configuration for the generator plugins.
   *
   * All logs emitted by this package should share the same prefix:
   * `[vue-pom-generator]`.
   */
  logging?: {
    /**
     * Controls log volume.
     *
     * - `"silent"`: no logs
     * - `"warn"` (default): only warnings and errors
     * - `"info"`: high-level lifecycle logs
     * - `"debug"`: verbose diagnostics
     */
    verbosity?: "silent" | "warn" | "info" | "debug";
  };

  /**
   * Configuration for injecting/deriving test ids from Vue templates.
   */
  injection?: {
    /**
     * HTML attribute name to inject/treat as the "test id".
     *
     * Defaults to `data-testid`.
     *
     * Common alternatives: `data-qa`, `data-cy`.
     */
    attribute?: string;

    /**
      * Directory used to identify "views" (pages) vs normal components.
      *
      * Behavior:
      * - Resolved relative to the Vite project root (resolved `config.root`) when not absolute.
      * - A Vue file is treated as a "view" when it is contained within this directory
      *   (using `path.relative` containment checks).
      *
      * Default: `"src/views"`.
     */
    viewsDir?: string;

    /**
     * Wrapper component configuration.
     */
    nativeWrappers?: NativeWrappersMap;

    /** Components to exclude from test id injection/collection. */
    excludeComponents?: string[];

    /**
     * Directories to scan for Vue files when building the POM library.
     *
     * Defaults to `["src"]`.
     *
     * For Nuxt projects, you might want to include `["app", "components", "pages", "layouts"]`.
     */
    scanDirs?: string[];

    /**
     * What to do when the author already provided a test id attribute.
     *
     * - `"preserve"` (default): keep the existing value
     * - `"overwrite"`: replace it with the generated value
     * - `"error"`: throw to force cleanup/migration
     */
    existingIdBehavior?: ExistingIdBehavior;
  };

  /**
   * Code generation configuration.
   *
   * Set to `false` to disable code generation entirely while still injecting/collecting test ids.
   */
  generation?: false | {
    /**
     * Output directory for generated files.
     *
      * Defaults to `tests/playwright/generated` (relative to the Vite project root).
      *
      * Generated outputs (by default):
      * - `<outDir>/page-object-models.g.ts`
      * - `<outDir>/index.ts` (stable barrel that re-exports from `page-object-models.g`)
     */
    outDir?: string;

    /**
     * Which languages to emit Page Object Models for.
     *
     * Defaults to ["ts"].
     *
     * Notes:
     * - "ts" emits the existing Playwright TypeScript POMs.
     * - "csharp" emits Playwright .NET (C#) POMs.
     */
    emit?: Array<"ts" | "csharp">;

    /**
     * Configuration for C# generation.
     */
    csharp?: {
      /**
       * The namespace to use for the generated C# classes.
       *
       * Defaults to `Playwright.Generated`.
       */
      namespace?: string;
    };

    /**
     * Controls how to handle POM member-name collisions (duplicate getter/method names) within a single class.
     *
      * Why this can happen (examples):
      *
      * 1) **Two elements map to the same inferred action name**
      *    - Example: a "Save" button and a toolbar "Save" link both end up inferred as `clickSave()`
      *      (e.g. both call the same `@click="save"` handler, or the same router destination).
      *
      * 2) **Conditional branches produce the same semantic name**
      *    - Example: `v-if="isCreate"` and `v-else` render two different buttons, but both infer the
      *      same action name (e.g. `clickSubmit()`), because the naming signals are intentionally limited
      *      (we do not use innerText-based disambiguation).
      *
      * 3) **Wrapper components collapse distinct elements into the same role/name**
      *    - Example: multiple wrapper components that all behave like buttons (e.g. `<MyButton>`,
      *      `<LoadButton>`) can generate very similar naming when neither element has a distinct id/name
      *      or handler-derived hint.
      *
      * 4) **Keyed/templated test ids intentionally share a base name**
      *    - Example: a list of row actions might yield `ClickDeleteByKey(key)` and a non-keyed
      *      `ClickDelete()` in the same class if both exist in different template shapes.
      *
      * Recommended practice:
      * - Use `"error"` in CI to catch accidental API ambiguity early.
      * - Resolve collisions by adding a stable naming signal (distinct handler, distinct id/name, or
      *   structural change) rather than relying on silent suffixing.
      *
     * - "error": throw and fail the compilation on the first collision encountered
     * - "warn": log a warning and append a numeric suffix to disambiguate
     * - "suffix": append a numeric suffix silently (default)
     */
    nameCollisionBehavior?: PomNameCollisionBehavior;

    /**
     * Absolute path to the BasePage template module to inline into generated output.
     * Defaults to the copy shipped with this package: ./class-generation/BasePage.ts.
     */
    basePageClassPath?: string;

    /**
     * Router integration used for resolving `:to` directives and emitting navigation helpers.
     *
     * If omitted, router introspection is disabled.
     */
    router?: {
      /**
       * The entry point for router introspection.
       *
       * For standard Vue apps, this is usually `src/router/index.ts`.
       *
       * For Nuxt projects, this can be omitted if `type` is set to `"nuxt"`.
       */
      entry?: string;

      /**
       * The type of router introspection to perform.
       *
       * - `"vue-router"` (default): loads the router entry via Vite SSR and enumerates routes.
       * - `"nuxt"`: infers routes from the directory structure (e.g. `app/pages` or `pages`).
       */
      type?: "vue-router" | "nuxt";
    };

    /** Playwright-specific generation features (fixtures + custom POM helpers). */
    playwright?: {
      /**
       * Generate Playwright fixture helpers alongside generated POMs.
       *
       * Default output (when `true`):
        * - `<projectRoot>/tests/playwright/generated/fixtures.g.ts`
       */
      fixtures?: boolean | string | { outDir?: string };

      /** Handwritten Page Object Model helpers and attachments. */
      customPoms?: {
        /**
         * Directory containing handwritten helpers to import into generated output.
         *
         * Defaults to `tests/playwright/pom/custom` (relative to the Vite project root).
         */
        dir?: string;

        /** Optional import aliases for handwritten helpers (basename -> alias). */
        importAliases?: Record<string, string>;

        /** Conditional helper attachments. */
        attachments?: Array<{
          className: string;
          propertyName: string;
          attachWhenUsesComponents: string[];
          attachTo?: "views" | "components" | "both";
        }>;
      };
    };
  };
}
