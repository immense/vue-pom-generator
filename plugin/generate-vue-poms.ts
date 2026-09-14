import path from "node:path";
import type { InlineConfig, Plugin } from "vite";
import { createGeneratorPlugins } from "./create-vue-pom-generator-plugins";
import type { VuePomGeneratorPluginOptions } from "./types";

/** Explicit Vite integration; the application's vite.config is never loaded implicitly. */
export type VuePomGenerationViteOptions = Pick<InlineConfig, "root" | "mode" | "resolve" | "plugins" | "logLevel">;

// Router introspection currently publishes process-wide state. Fail explicitly
// rather than mixing two projects' route maps in concurrent one-shot calls.
let generating = false;

/**
 * Generate all configured POMs once, without starting the app server or bundling the app.
 * Await this before starting a typechecker that consumes generated imports.
 */
export async function generateVuePoms(
  options: VuePomGeneratorPluginOptions = {},
  viteOptions: VuePomGenerationViteOptions = {},
): Promise<void> {
  if (options.generation === false) {
    throw new Error("[vue-pom-generator] generateVuePoms requires generation to be enabled.");
  }
  const entryId = "virtual:vue-pom-generator-entry";
  const resolvedEntryId = `\0${entryId}`;
  const entry: Plugin = {
    name: "vue-pom-generator-entry",
    resolveId(id) {
      return id === entryId ? resolvedEntryId : undefined;
    },
    load(id) {
      return id === resolvedEntryId ? "export {};" : undefined;
    },
  };
  if (generating) {
    throw new Error("[vue-pom-generator] Await the previous generateVuePoms call before starting another.");
  }
  generating = true;
  try {
    // Keep the Node-only Vite runtime out of imports used by component-test environments.
    const { build } = await import("vite");
    await build({
      ...viteOptions,
      configFile: false,
      publicDir: false,
      plugins: [entry, ...createGeneratorPlugins(options, true, path.resolve(viteOptions.root ?? ".")), ...(viteOptions.plugins ?? [])],
      build: {
        write: false,
        emptyOutDir: false,
        minify: false,
        rollupOptions: { input: entryId },
      },
    });
  }
  finally {
    generating = false;
  }
}
