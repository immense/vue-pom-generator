import type { Options as VuePluginOptions } from "@vitejs/plugin-vue";
import type { NativeWrappersMap } from "../utils";

export type ExistingIdBehavior = "preserve" | "overwrite" | "error";

export interface VuePomGeneratorPluginOptions {
  /** Options forwarded to @vitejs/plugin-vue */
  vueOptions?: VuePluginOptions;

  /**
   * Configuration for injecting/deriving test ids from Vue templates.
   *
   * This plugin can still *collect* metadata for code generation even when injection is disabled.
   */
  injection?: {
    /**
     * Whether to inject the attribute into the compiled template output.
     *
     * - `true` (default): inject/overwrite (depending on existingIdBehavior)
     * - `false`: collect-only (useful if your app already renders stable ids, but you still want POM generation)
     */
    enabled?: boolean;

    /**
     * HTML attribute name to inject/treat as the "test id".
     *
     * Defaults to `data-testid`.
     *
     * Common alternatives: `data-qa`, `data-cy`.
     */
    attribute?: string;

    /**
     * Folder convention used to identify "pages" (Nuxt/Vue) or "views" (this repo).
     *
     * Behavior:
     * - This is a simple *substring* match against the normalized absolute Vue file path.
     * - If the file path contains `/<viewsDir>/` the component is treated as a "view".
     *
     * Default: `"src/views"` (no leading slash).
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
     * Defaults to `./pom` (relative to `process.cwd()` when not absolute).
     */
    outDir?: string;

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
       * - `<projectRoot>/tests/playwright/fixture/Fixtures.g.ts`
       */
      fixtures?: boolean | string | { outDir?: string };

      /** Handwritten Page Object Model helpers and attachments. */
      customPoms?: {
        /** Directory containing handwritten helpers to inline/import. Defaults to `<outDir>/custom`. */
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
