import createVuePomGeneratorPlugins from "./plugin/create-vue-pom-generator-plugins";

import type { NuxtPomGeneratorPluginOptions, VuePomGeneratorPluginOptions } from "./plugin/types";

const nuxtConfigMarker = Symbol.for("@immense/vue-pom-generator.nuxt");

export { createVuePomGeneratorPlugins };
export { createVuePomGeneratorPlugins as vuePomGenerator };
export default createVuePomGeneratorPlugins;

export function defineVuePomGeneratorConfig(options: VuePomGeneratorPluginOptions): VuePomGeneratorPluginOptions {
  return options;
}

export function defineNuxtPomGeneratorConfig(options: NuxtPomGeneratorPluginOptions): NuxtPomGeneratorPluginOptions {
  const markedOptions = { ...options } as NuxtPomGeneratorPluginOptions & { [nuxtConfigMarker]?: true };
  Object.defineProperty(markedOptions, nuxtConfigMarker, {
    value: true,
    enumerable: false,
  });
  return markedOptions;
}

export type { ExistingIdBehavior, MissingSemanticNameBehavior, NuxtPomGeneratorPluginOptions, PomGeneratorPluginOptions, PomNameCollisionBehavior, VuePomGeneratorPluginOptions } from "./plugin/types";
