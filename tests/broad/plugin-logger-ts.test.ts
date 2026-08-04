// @vitest-environment node
import type { Logger } from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { VUE_POM_GENERATOR_LOG_PREFIX, createLogger } from "../../plugin/logger";

/** Builds a complete Vite `Logger` double so `createLogger`'s `viteLogger` slot
 * is satisfied without a type-bypass cast. Methods default to no-op `vi.fn()`
 * spies; pass the ones you want to assert on via `overrides`. */
function makeViteLogger(overrides: Partial<Logger> = {}): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    warnOnce: vi.fn(),
    error: vi.fn(),
    clearScreen: vi.fn(),
    hasErrorLogged: () => false,
    hasWarned: false,
    ...overrides,
  };
}

describe("createLogger", () => {
  describe("normalize (via viteLogger capture)", () => {
    it("prefixes a plain message", () => {
      const info = vi.fn();
      const logger = createLogger({ verbosity: "info", viteLogger: makeViteLogger({ info }) });
      logger.info("hello");
      expect(info).toHaveBeenCalledWith(`${VUE_POM_GENERATOR_LOG_PREFIX} hello`);
    });

    it("returns only the prefix when the message trims to empty", () => {
      const info = vi.fn();
      const logger = createLogger({ verbosity: "info", viteLogger: makeViteLogger({ info }) });
      logger.info("   ");
      expect(info).toHaveBeenCalledWith(VUE_POM_GENERATOR_LOG_PREFIX);
    });

    it("does not double-prefix a message that already starts with the prefix", () => {
      const info = vi.fn();
      const logger = createLogger({ verbosity: "info", viteLogger: makeViteLogger({ info }) });
      logger.info(`${VUE_POM_GENERATOR_LOG_PREFIX} already`);
      expect(info).toHaveBeenCalledWith(`${VUE_POM_GENERATOR_LOG_PREFIX} already`);
    });

    it("treats null/undefined message as empty", () => {
      const info = vi.fn();
      const logger = createLogger({ verbosity: "info", viteLogger: makeViteLogger({ info }) });
      // @ts-expect-error exercising nullish input
      logger.info(undefined);
      // @ts-expect-error exercising null input
      logger.info(null);
      expect(info).toHaveBeenNthCalledWith(1, VUE_POM_GENERATOR_LOG_PREFIX);
      expect(info).toHaveBeenNthCalledWith(2, VUE_POM_GENERATOR_LOG_PREFIX);
    });
  });

  describe("sink routing with viteLogger", () => {
    it("routes info to viteLogger.info", () => {
      const info = vi.fn();
      const warn = vi.fn();
      const logger = createLogger({ verbosity: "debug", viteLogger: makeViteLogger({ info, warn }) });
      logger.info("a");
      expect(info).toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    });

    it("routes warn to viteLogger.warn", () => {
      const info = vi.fn();
      const warn = vi.fn();
      const logger = createLogger({ verbosity: "debug", viteLogger: makeViteLogger({ info, warn }) });
      logger.warn("b");
      expect(warn).toHaveBeenCalled();
      expect(info).not.toHaveBeenCalled();
    });

    it("routes debug to viteLogger.info (no dedicated debug channel)", () => {
      const info = vi.fn();
      const logger = createLogger({ verbosity: "debug", viteLogger: makeViteLogger({ info }) });
      logger.debug("c");
      expect(info).toHaveBeenCalledWith(expect.stringContaining("c"));
    });
  });

  describe("sink routing without viteLogger (console fallback)", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("routes info to console.log when no viteLogger", () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const logger = createLogger({ verbosity: "info" });
      logger.info("plain");
      expect(log).toHaveBeenCalledWith(expect.stringContaining("plain"));
    });

    it("routes warn to console.warn when no viteLogger", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const logger = createLogger({ verbosity: "warn" });
      logger.warn("danger");
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("danger"));
    });

    it("routes debug to console.log when no viteLogger", () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const logger = createLogger({ verbosity: "debug" });
      logger.debug("dbg");
      expect(log).toHaveBeenCalledWith(expect.stringContaining("dbg"));
    });
  });

  describe("verbosity gating", () => {
    it("silent suppresses info, warn, and debug", () => {
      const info = vi.fn();
      const warn = vi.fn();
      const logger = createLogger({ verbosity: "silent", viteLogger: makeViteLogger({ info, warn }) });
      logger.info("i");
      logger.debug("d");
      logger.warn("w");
      expect(info).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    });

    it("warn suppresses info and debug but allows warn", () => {
      const info = vi.fn();
      const warn = vi.fn();
      const logger = createLogger({ verbosity: "warn", viteLogger: makeViteLogger({ info, warn }) });
      logger.info("i");
      logger.debug("d");
      logger.warn("w");
      expect(info).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it("info allows info and warn but suppresses debug", () => {
      const info = vi.fn();
      const warn = vi.fn();
      const logger = createLogger({ verbosity: "info", viteLogger: makeViteLogger({ info, warn }) });
      logger.info("i");
      logger.debug("d");
      logger.warn("w");
      expect(info).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it("debug allows info, debug, and warn", () => {
      const info = vi.fn();
      const warn = vi.fn();
      const logger = createLogger({ verbosity: "debug", viteLogger: makeViteLogger({ info, warn }) });
      logger.info("i");
      logger.debug("d");
      logger.warn("w");
      expect(info).toHaveBeenCalledTimes(2); // info + debug both go to info
      expect(warn).toHaveBeenCalledTimes(1);
    });
  });
});
