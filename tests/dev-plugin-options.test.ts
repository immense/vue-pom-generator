// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import { createDevProcessorPlugin } from "../plugin/support/dev-plugin";
import type { IComponentDependencies, NativeWrappersMap } from "../utils";

interface CreateTestIdTransformOptions {
  existingIdBehavior?: string;
  nameCollisionBehavior?: string;
  testIdAttribute?: string;
  warn?: (message: string) => void;
  vueFilesPathMap?: Map<string, string>;
  wrapperSearchRoots?: string[];
}

type CreateTestIdTransformCall = [
  string,
  Map<string, IComponentDependencies>,
  NativeWrappersMap,
  string[],
  string,
  CreateTestIdTransformOptions,
];

type GenerateFilesCall = [
  Map<string, IComponentDependencies>,
  Map<string, string>,
  string,
  { viewsDir?: string; scanDirs?: string[] },
];

interface DevServerStub {
  watcher: {
    add: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
  };
  restart: ReturnType<typeof vi.fn>;
}

const mocks = vi.hoisted(() => ({
  createTestIdTransform: vi.fn((..._args: CreateTestIdTransformCall) => () => {}),
  generateFiles: vi.fn(async (..._args: GenerateFilesCall) => undefined),
}));

vi.mock("../transform", () => ({
  createTestIdTransform: mocks.createTestIdTransform,
}));

vi.mock("../class-generation", () => ({
  generateFiles: mocks.generateFiles,
}));

function createDevServerStub(): DevServerStub {
  const server = {
    watcher: {
      add: vi.fn(),
      on: vi.fn(),
    },
    restart: vi.fn(),
  };

  return server;
}

async function waitForCallCount(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("Timed out waiting for dev generation");
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

describe("dev processor option plumbing", () => {
  it("passes collision and route context options into snapshot generation", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vue-pom-generator-dev-"));

    try {
      fs.mkdirSync(path.join(projectRoot, "src", "views"), { recursive: true });
      fs.writeFileSync(
        path.join(projectRoot, "src", "views", "MyPage.vue"),
        "<template><button>Save</button></template>",
        "utf8",
      );

      const warn = vi.fn();
      const wrapperSearchRoots = [path.join(projectRoot, "shared-wrappers")];
      const basePageClassPath = path.join(projectRoot, "BasePage.ts");

      const plugin = createDevProcessorPlugin({
        nativeWrappers: {},
        excludedComponents: [],
        viewsDir: "src/views",
        scanDirs: ["src"],
        getWrapperSearchRoots: () => wrapperSearchRoots,
        projectRootRef: { current: projectRoot },
        normalizedBasePagePath: path.posix.normalize(basePageClassPath),
        basePageClassPath,
        customPomAttachments: [],
        nameCollisionBehavior: "error",
        testIdAttribute: "data-testid",
        routerAwarePoms: false,
        loggerRef: {
          current: {
            info() {},
            debug() {},
            warn,
          },
        },
      });

      const devPlugin = plugin as { configureServer?: (server: DevServerStub) => void | Promise<void> };
      const server = createDevServerStub();
      const configureServer = devPlugin.configureServer;
      if (!configureServer) {
        throw new Error("Expected configureServer to exist");
      }
      await configureServer(server);

      await waitForCallCount(() => mocks.generateFiles.mock.calls.length > 0);

      expect(mocks.createTestIdTransform).toHaveBeenCalledTimes(1);
      const transformCall = mocks.createTestIdTransform.mock.calls[0];
      if (!transformCall) {
        throw new Error("Expected createTestIdTransform to be called");
      }
      const transformOptions = transformCall[5];

      expect(transformCall[4]).toBe(path.resolve(projectRoot, "src", "views"));
      expect(transformOptions).toMatchObject({
        existingIdBehavior: "preserve",
        nameCollisionBehavior: "error",
        testIdAttribute: "data-testid",
        wrapperSearchRoots,
      });
      expect(transformOptions.warn).toBeTypeOf("function");
      transformOptions.warn?.("collision");
      expect(warn).toHaveBeenCalledWith("collision");
      expect(transformOptions.vueFilesPathMap?.get("MyPage")).toBe(path.join(projectRoot, "src", "views", "MyPage.vue"));

      const generateCall = mocks.generateFiles.mock.calls[0];
      if (!generateCall) {
        throw new Error("Expected generateFiles to be called");
      }
      const generateOptions = generateCall[3];

      expect(generateOptions).toMatchObject({
        viewsDir: "src/views",
        scanDirs: ["src"],
      });
    }
    finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
