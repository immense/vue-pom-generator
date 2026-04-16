import createVuePomGeneratorPlugins from "./plugin/create-vue-pom-generator-plugins";

import type { NuxtPomGeneratorPluginOptions, VuePomGeneratorPluginOptions } from "./plugin/types";

export { createVuePomGeneratorPlugins };
export { createVuePomGeneratorPlugins as vuePomGenerator };
export default createVuePomGeneratorPlugins;

export function defineVuePomGeneratorConfig(options: VuePomGeneratorPluginOptions): VuePomGeneratorPluginOptions {
  return options;
}

export function defineNuxtPomGeneratorConfig(options: Omit<NuxtPomGeneratorPluginOptions, "framework">): NuxtPomGeneratorPluginOptions {
  return {
    framework: "nuxt",
    ...options,
  };
}

export type { ExistingIdBehavior, NuxtPomGeneratorPluginOptions, PomGeneratorPluginOptions, PomNameCollisionBehavior, VuePomGeneratorPluginOptions } from "./plugin/types";
