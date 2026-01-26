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
     * - `"info"` (default): high-level lifecycle logs
     * - `"debug"`: verbose diagnostics
     */
    verbosity?: "silent" | "info" | "debug";
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
     * Controls how to handle POM member-name collisions (duplicate getter/method names) within a single class.
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
    router?: { entry: string };

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
