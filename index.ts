import createVuePomGeneratorPlugins from "./plugin/create-vue-pom-generator-plugins";

import type { VuePomGeneratorPluginOptions } from "./plugin/types";

export { createVuePomGeneratorPlugins };
export { createVuePomGeneratorPlugins as vuePomGenerator };
export default createVuePomGeneratorPlugins;

export function defineVuePomGeneratorConfig(options: VuePomGeneratorPluginOptions): VuePomGeneratorPluginOptions {
  return options;
}

export type { ExistingIdBehavior, PomNameCollisionBehavior, VuePomGeneratorPluginOptions } from "./plugin/types";
