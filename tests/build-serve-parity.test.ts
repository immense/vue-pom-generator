// @vitest-environment node
/**
 * Build–serve parity integration tests.
 *
 * These tests exercise the actual dev-plugin and build-plugin code paths
 * to verify that fixes remain in place. Each test is designed to FAIL
 * if its corresponding fix is reverted.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { CompilerOptions } from "@vue/compiler-dom";
import * as compilerDom from "@vue/compiler-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateFiles } from "../class-generation";
import { createDevProcessorPlugin } from "../plugin/support/dev-plugin";
import { getGenerationMetrics } from "../plugin/support/generation-metrics";

// Mock generateFiles so the dev plugin doesn't try to write real files
// (which would fail because base-page.ts doesn't exist in the temp dir).
// We're testing the compile path, not file generation.
vi.mock("../class-generation", () => ({
  generateFiles: vi.fn(async () => undefined),
}));

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

interface DevServerStub {
  watcher: {
    add: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
  };
  config: {
    logger: {
      error: ReturnType<typeof vi.fn>;
    };
  };
  restart: ReturnType<typeof vi.fn>;
}

function createDevServerStub(): DevServerStub {
  return {
    watcher: {
      add: vi.fn(),
      on: vi.fn(),
    },
    config: {
      logger: {
        error: vi.fn(),
      },
    },
    restart: vi.fn(),
  };
}

function getWatcherHandler(server: DevServerStub, event: string) {
  const call = server.watcher.on.mock.calls.find(([name]) => name === event);
  expect(call).toBeTruthy();
  return call![1] as (path: string) => void;
}

function createTmpProjectWithSfc(
  fixture: string,
  filename: string,
): { projectRoot: string; cleanup: () => void } {
  const projectRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "pom-parity-test-"),
  );
  fs.mkdirSync(path.join(projectRoot, "src", "views"), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, "src", "components"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(projectRoot, "src", "components", filename),
    fixture,
  );
  return {
    projectRoot,
    cleanup: () => fs.rmSync(projectRoot, { recursive: true, force: true }),
  };
}

function makeDevPlugin(
  projectRoot: string,
  overrides?: Record<string, unknown>,
) {
  const basePageClassPath = path.join(projectRoot, "base-page.ts");
  return createDevProcessorPlugin({
    nativeWrappers: {},
    excludedComponents: [],
    viewsDir: "src/views",
    scanDirs: ["src"],
    getWrapperSearchRoots: () => [],
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
        warn() {},
      },
    },
    ...overrides,
  } as any);
}

// ---------------------------------------------------------------------------
// Test 1: SFC-aware compilation — the dev plugin must pass bindingMetadata
// and inline:true to compilerDom.compile for <script setup> components.
// ---------------------------------------------------------------------------

describe("build–serve parity: dev plugin integration", () => {
  let compileSpy: ReturnType<typeof vi.spyOn>;
  const realCompile = compilerDom.compile;

  beforeEach(() => {
    compileSpy = vi.spyOn(compilerDom, "compile");
    vi.mocked(generateFiles).mockClear();
  });

  afterEach(() => {
    compileSpy.mockRestore();
  });

  it("passes bindingMetadata and inline:true for <script setup> components", async () => {
    const { projectRoot, cleanup } = createTmpProjectWithSfc(
      `<script setup lang="ts">
import { ref } from "vue"
const showDialog = ref(false)
function openDialog() {}
</script>
<template>
  <div>
    <button @click="openDialog()">Open</button>
  </div>
</template>`,
      "MyDialog.vue",
    );

    try {
      const plugin = makeDevPlugin(projectRoot);
      const server = createDevServerStub();
      await (plugin as any).configureServer!(server);

      // Find the compile call for our fixture.
      const calls = compileSpy.mock.calls;
      expect(calls.length).toBeGreaterThan(0);

      const dialogCall = calls.find(
        (c: unknown[]) => (c[1] as any)?.filename?.includes("MyDialog.vue"),
      );
      expect(dialogCall).toBeTruthy();

      const opts = dialogCall![1] as Record<string, unknown>;

      // The fix: inline should be true for <script setup>.
      expect(opts.inline).toBe(true);

      // The fix: bindingMetadata should include the setup bindings.
      const bindings = opts.bindingMetadata as Record<string, string>;
      expect(bindings).toBeTruthy();
      expect(bindings.showDialog).toBe("setup-ref");
      expect(bindings.openDialog).toBe("setup-const");
    } finally {
      cleanup();
    }
  });

  it("does NOT pass inline:true for Options API components", async () => {
    const { projectRoot, cleanup } = createTmpProjectWithSfc(
      `<script lang="ts">
import { defineComponent, ref } from "vue"
export default defineComponent({
  setup() {
    const count = ref(0)
    return { count }
  },
})
</script>
<template>
  <div>
    <button @click="count++">Increment</button>
  </div>
</template>`,
      "Counter.vue",
    );

    try {
      const plugin = makeDevPlugin(projectRoot);
      const server = createDevServerStub();
      await (plugin as any).configureServer!(server);

      const calls = compileSpy.mock.calls;
      const counterCall = calls.find(
        (c: unknown[]) => (c[1] as any)?.filename?.includes("Counter.vue"),
      );
      expect(counterCall).toBeTruthy();

      const opts = counterCall![1] as Record<string, unknown>;

      // Options API should NOT get inline mode.
      expect(opts.inline).toBeFalsy();

      // compileScript can't infer bindings from Options API setup() return,
      // so bindingMetadata should be empty or undefined.
      const bindings = opts.bindingMetadata as Record<string, string> | undefined;
      if (bindings) {
        expect(Object.keys(bindings).length).toBe(0);
      }
    } finally {
      cleanup();
    }
  });

  it("does NOT pass inline/bindingMetadata for template-only components", async () => {
    const { projectRoot, cleanup } = createTmpProjectWithSfc(
      '<template><button @click="save()">Save</button></template>',
      "SimpleButton.vue",
    );

    try {
      const plugin = makeDevPlugin(projectRoot);
      const server = createDevServerStub();
      await (plugin as any).configureServer!(server);

      const calls = compileSpy.mock.calls;
      const simpleCall = calls.find(
        (c: unknown[]) => (c[1] as any)?.filename?.includes("SimpleButton.vue"),
      );
      expect(simpleCall).toBeTruthy();

      const opts = simpleCall![1] as Record<string, unknown>;

      // No script block → no bindings, no inline.
      expect(opts.inline).toBeFalsy();
      expect(opts.bindingMetadata).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  // -----------------------------------------------------------------------
  // Test 2: existingIdBehavior forwarding
  // Before the fix, existingIdBehavior was hardcoded to "preserve".
  // -----------------------------------------------------------------------

  it("forwards existingIdBehavior='error' from config (rejects on existing testid)", async () => {
    const { projectRoot, cleanup } = createTmpProjectWithSfc(
      '<template><button data-testid="manual-id" @click="save()">Save</button></template>',
      "Existing.vue",
    );

    try {
      const plugin = makeDevPlugin(projectRoot, {
        existingIdBehavior: "error",
      });
      const server = createDevServerStub();

      // With existingIdBehavior: "error", the dev plugin should reject
      // because the fixture already has a data-testid attribute.
      await expect(
        (plugin as any).configureServer!(server),
      ).rejects.toThrow();
    } finally {
      cleanup();
    }
  });

  it("existingIdBehavior='preserve' does NOT reject on existing testid", async () => {
    const { projectRoot, cleanup } = createTmpProjectWithSfc(
      '<template><button data-testid="manual-id" @click="save()">Save</button></template>',
      "Existing.vue",
    );

    try {
      const plugin = makeDevPlugin(projectRoot, {
        existingIdBehavior: "preserve",
      });
      const server = createDevServerStub();

      // Should NOT throw.
      await (plugin as any).configureServer!(server);
    } finally {
      cleanup();
    }
  });

  it("regenerates with fewer components when a vue file is legitimately deleted", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pom-parity-delete-"));
    fs.mkdirSync(path.join(projectRoot, "src", "components"), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, "src", "views"), { recursive: true });

    const alphaPath = path.join(projectRoot, "src", "components", "Alpha.vue");
    const betaPath = path.join(projectRoot, "src", "components", "Beta.vue");
    fs.writeFileSync(alphaPath, '<template><button @click="save()">Alpha</button></template>');
    fs.writeFileSync(betaPath, '<template><button @click="save()">Beta</button></template>');

    try {
      const plugin = makeDevPlugin(projectRoot);
      const server = createDevServerStub();
      await (plugin as any).configureServer!(server);

      const initialSnapshot = vi.mocked(generateFiles).mock.calls.at(-1)?.[0] as Map<string, unknown>;
      expect(initialSnapshot.size).toBe(2);

      fs.rmSync(betaPath);
      const unlink = getWatcherHandler(server, "unlink");
      unlink(betaPath);

      await new Promise(resolve => setTimeout(resolve, 900));

      const finalSnapshot = vi.mocked(generateFiles).mock.calls.at(-1)?.[0] as Map<string, unknown>;
      expect(finalSnapshot.size).toBe(1);
      expect(finalSnapshot.has("Alpha")).toBe(true);
      expect(finalSnapshot.has("Beta")).toBe(false);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("confirms suspicious incremental snapshots with a filesystem rebuild before emitting", async () => {
    const { projectRoot, cleanup } = createTmpProjectWithSfc(
      '<template><button @click="save()">Recover</button></template>',
      "Recoverable.vue",
    );

    try {
      const plugin = makeDevPlugin(projectRoot);
      const server = createDevServerStub();
      await (plugin as any).configureServer!(server);

      const initialSnapshot = vi.mocked(generateFiles).mock.calls.at(-1)?.[0] as Map<string, any>;
      const initialMetrics = getGenerationMetrics(initialSnapshot);
      expect(initialMetrics.selectorCount).toBeGreaterThan(0);

      let intercepted = false;
      compileSpy.mockImplementation((template: string, options?: CompilerOptions) => {
        if (!intercepted && (options as any)?.filename?.includes("Recoverable.vue")) {
          intercepted = true;
          return {} as any;
        }

        return realCompile(template, options as any);
      });

      await (plugin as any).handleHotUpdate({ file: path.join(projectRoot, "src", "components", "Recoverable.vue") });
      await new Promise(resolve => setTimeout(resolve, 900));

      const finalSnapshot = vi.mocked(generateFiles).mock.calls.at(-1)?.[0] as Map<string, any>;
      const finalMetrics = getGenerationMetrics(finalSnapshot);
      expect(finalMetrics).toEqual(initialMetrics);
    } finally {
      cleanup();
    }
  });
});
