import type { Logger as ViteLogger } from "vite";

export type VuePomGeneratorVerbosity = "silent" | "warn" | "info" | "debug";

export interface VuePomGeneratorLogger {
  info: (message: string) => void;
  debug: (message: string) => void;
  warn: (message: string) => void;
}

export const VUE_POM_GENERATOR_LOG_PREFIX = "[vue-pom-generator]" as const;

function normalize(message: string): string {
  const trimmed = (message ?? "").trim();
  if (!trimmed)
    return VUE_POM_GENERATOR_LOG_PREFIX;
  if (trimmed.startsWith(VUE_POM_GENERATOR_LOG_PREFIX))
    return trimmed;
  return `${VUE_POM_GENERATOR_LOG_PREFIX} ${trimmed}`;
}

export function createLogger(options: {
  verbosity: VuePomGeneratorVerbosity;
  viteLogger?: ViteLogger;
}): VuePomGeneratorLogger {
  const { verbosity, viteLogger } = options;

  const sinkInfo = (msg: string) => {
    if (viteLogger) {
      viteLogger.info(normalize(msg));
      return;
    }
    console.log(normalize(msg));
  };

  const sinkWarn = (msg: string) => {
    if (viteLogger) {
      viteLogger.warn(normalize(msg));
      return;
    }
    console.warn(normalize(msg));
  };

  const sinkDebug = (msg: string) => {
    // No dedicated debug channel in Vite logger; info is fine when verbosity=debug.
    if (viteLogger) {
      viteLogger.info(normalize(msg));
      return;
    }
    console.log(normalize(msg));
  };

  return {
    info(message: string) {
      if (verbosity === "silent" || verbosity === "warn")
        return;
      sinkInfo(message);
    },
    debug(message: string) {
      if (verbosity !== "debug")
        return;
      sinkDebug(message);
    },
    warn(message: string) {
      if (verbosity === "silent")
        return;
      sinkWarn(message);
    },
  };
}
