import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { build } from "vite";

import { resolveAnnotatorSourceRoot, annotatorSourcePath } from "../plugin/annotator-source";
import { createVuePomGeneratorPlugins } from "../plugin/create-vue-pom-generator-plugins";
import { __internal } from "../plugin/runtime/annotator/plugin";

const { addComponentMetadata } = __internal;
const roots: string[] = [];
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "annotator-source-")));
  roots.push(root);
  fs.mkdirSync(path.join(root, "frontend/src/views"), { recursive: true });
  return root;
}
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

describe("annotator source roots", () => {
  it.each(["directory", "worktree file"])("finds the nearest .git %s above the Vite root", (kind) => {
    const root = fixture();
    if (kind === "directory") fs.mkdirSync(path.join(root, ".git"));
    else fs.writeFileSync(path.join(root, ".git"), "gitdir: /unused/worktree");
    const app = path.join(root, "frontend");
    expect(resolveAnnotatorSourceRoot(app)).toBe(root);
    expect(annotatorSourcePath(path.join(app, "src/views/Page.vue"), root)).toBe("frontend/src/views/Page.vue");
    expect(annotatorSourcePath(path.join(root, "shared/ui/src/Button.vue"), root)).toBe("shared/ui/src/Button.vue");
    fs.mkdirSync(path.join(app, ".git"));
    expect(resolveAnnotatorSourceRoot(app)).toBe(app);
  });

  it("requires an explicit sourceRoot for archives, resolved relative to the Vite root", () => {
    const root = fixture();
    const app = path.join(root, "frontend");
    expect(() => resolveAnnotatorSourceRoot(app)).toThrow("Set runtime.annotator.sourceRoot");
    expect(resolveAnnotatorSourceRoot(app, "..")).toBe(root);
    expect(resolveAnnotatorSourceRoot(app, root)).toBe(root);
    expect(() => resolveAnnotatorSourceRoot(app, " ")).toThrow("non-empty");
    expect(() => resolveAnnotatorSourceRoot(app, "../missing")).toThrow("runtime.annotator.sourceRoot must be a directory");
    fs.writeFileSync(path.join(root, "file"), "");
    expect(() => resolveAnnotatorSourceRoot(app, "../file")).toThrow("directory");
  });

  it.each([false, true])("uses repository paths in a production build (explicit root: %s)", async (explicit) => {
    const root = fixture();
    if (!explicit) fs.mkdirSync(path.join(root, ".git"));
    const app = path.join(root, "frontend");
    fs.writeFileSync(path.join(app, "src/views/Page.vue"), '<template>\n  <h1>Page</h1>\n</template>');
    const result = await build({
      configFile: false,
      root: app,
      logLevel: "silent",
      plugins: createVuePomGeneratorPlugins({
        generation: false,
        runtime: { annotator: { enabled: true, ...(explicit && { sourceRoot: ".." }) } },
      }),
      build: {
        write: false,
        minify: false,
        lib: { entry: path.join(app, "src/views/Page.vue"), formats: ["es"] },
        rollupOptions: { external: ["vue"] },
      },
    });
    const output = (Array.isArray(result) ? result[0] : result);
    if (!("output" in output)) throw new Error("Expected a bundle");
    const code = output.output.filter(chunk => chunk.type === "chunk").map(chunk => chunk.code).join("\n");
    expect(code).toContain('"data-v-inspector": "frontend/src/views/Page.vue:2:3"');
    expect(code).toContain('"frontend/src/views/Page.vue"');
    expect(code).toContain("dataVPomUsage");
    expect(code).not.toContain(root);
  });
});

describe("compiled component metadata", () => {
  it("sets __file and consumes the usage prop on the component exported through _export_sfc", () => {
    const compiled = 'const _sfc_main = {};\nexport default _export_sfc(_sfc_main, [["render", render]]);';
    const updated = addComponentMetadata(compiled, "shared/ui/Card.vue", "data-v-pom-usage");
    expect(updated?.startsWith(compiled)).toBe(true);
    expect(updated).toContain('_sfc_main.__file = "shared/ui/Card.vue";');
    expect(updated).toContain('"dataVPomUsage"');
  });

  it("handles direct exports and custom prefixes, leaving non-component modules alone", () => {
    expect(addComponentMetadata("const _sfc_main = {};\nexport default _sfc_main;", "src/Card.vue", "data-custom-usage"))
      .toContain('"dataCustomUsage"');
    expect(addComponentMetadata("export const value = 1;", "src/Plain.vue", "data-v-pom-usage")).toBeUndefined();
  });
});
