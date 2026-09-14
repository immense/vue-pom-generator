import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vue from "@vitejs/plugin-vue";
import { build } from "vite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateVuePoms, vuePomGenerator, type VuePomGeneratorPluginOptions } from "../index";

describe("generateVuePoms", () => {
  let root: string;
  let options: VuePomGeneratorPluginOptions;
  const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");
  const exists = (relative: string) => fs.existsSync(path.join(root, relative));
  const write = (relative: string, content: string) => {
    const filePath = path.join(root, relative);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  };
  const generate = () => generateVuePoms(options, { root, logLevel: "silent" });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pom-generate-"));
    options = {
      generation: {
        basePageClassPath: fileURLToPath(new URL("../class-generation/base-page.ts", import.meta.url)),
        playwright: { outputStructure: "split", fixtures: true },
        vueTestUtils: {},
      },
    };
    write("src/components/SaveButton.vue", `<script setup lang="ts">\nconst save = () => {};\n</script>\n<template>\n<button @click="save" aria-label="Save changes">Save</button>\n</template>`);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("generates PW, VTU and fixtures relative to root without loading the app config or writing assets", async () => {
    write("vite.config.ts", 'throw new Error("application config must not run");');
    write("dist/keep.txt", "existing app assets");
    await generate();
    expect(read("tests/playwright/__generated__/SaveButton.g.ts")).toContain("class SaveButton");
    expect(read("tests/unit/__generated__/SaveButton.vtu.g.ts")).toContain("class SaveButton");
    expect(exists("tests/playwright/__generated__/fixtures.g.ts")).toBe(true);
    expect(fs.readdirSync(path.join(root, "dist"))).toEqual(["keep.txt"]);
    expect(read("dist/keep.txt")).toBe("existing app assets");
  });

  it("keeps compiler metadata and matches a real Vue build byte-for-byte", async () => {
    await generate();
    const manifestPath = "tests/playwright/__generated__/pom-manifest.g.ts";
    const manifest = read(manifestPath);
    expect(manifest).toContain('"sourceLine": 5');
    expect(manifest).toContain('"accessibility":');
    expect(manifest).toContain("Save changes");
    const pom = read("tests/playwright/__generated__/SaveButton.g.ts");
    // Compile the SFC through the real Vue plugin, not just the filesystem scan.
    await build({ configFile: false, root, logLevel: "silent", plugins: vuePomGenerator(options),
      build: { write: false, rollupOptions: { input: path.join(root, "src/components/SaveButton.vue"), external: ["vue"] } } });
    expect(read(manifestPath)).toBe(manifest);
    expect(read("tests/playwright/__generated__/SaveButton.g.ts")).toBe(pom);
  });

  it("prunes renamed components and supports an empty final snapshot in the same process", async () => {
    await generate();
    fs.renameSync(path.join(root, "src/components/SaveButton.vue"), path.join(root, "src/components/ConfirmButton.vue"));
    await generate();
    expect(exists("tests/playwright/__generated__/SaveButton.g.ts")).toBe(false);
    expect(exists("tests/unit/__generated__/SaveButton.vtu.g.ts")).toBe(false);
    expect(exists("tests/playwright/__generated__/ConfirmButton.g.ts")).toBe(true);
    fs.unlinkSync(path.join(root, "src/components/ConfirmButton.vue"));
    await generate();
    expect(exists("tests/playwright/__generated__/ConfirmButton.g.ts")).toBe(false);
    expect(exists("tests/unit/__generated__/ConfirmButton.vtu.g.ts")).toBe(false);
    expect(read("tests/playwright/__generated__/index.ts")).not.toContain("ConfirmButton");
  });

  it("prunes outputs when changing split/aggregate mode or disabling VTU/fixtures/C#", async () => {
    if (!options.generation) throw new Error("test requires generation");
    options.generation.emit = ["ts", "csharp"];
    options.generation.playwright!.fixtures = "setup/generated-fixtures.ts";
    await generate();
    const directory = path.join(root, "tests/playwright/__generated__");
    const csharpFiles = fs.readdirSync(directory).filter(file => file.endsWith(".cs"));
    expect(csharpFiles.length).toBeGreaterThan(0);
    options.generation.emit = ["ts"];
    options.generation.playwright = { outputStructure: "aggregated" };
    options.generation.vueTestUtils = undefined;
    await generate();
    expect(exists("tests/playwright/__generated__/SaveButton.g.ts")).toBe(false);
    expect(exists("tests/playwright/__generated__/page-object-models.g.ts")).toBe(true);
    expect(exists("tests/unit/__generated__/SaveButton.vtu.g.ts")).toBe(false);
    expect(exists("setup/generated-fixtures.ts")).toBe(false);
    expect(exists("setup/pom-manifest.g.ts")).toBe(false);
    expect(fs.readdirSync(directory).filter(file => file.endsWith(".cs"))).toEqual([]);
  });

  it("leaves the last good outputs intact when parsing or emission fails", async () => {
    await generate();
    const pomPath = "tests/playwright/__generated__/SaveButton.g.ts";
    const before = read(pomPath);
    const manifestPath = "tests/playwright/__generated__/.vue-pom-generator-outputs.json";
    const manifest = read(manifestPath);
    write("src/components/SaveButton.vue", "<template><button></template>");
    await expect(generate()).rejects.toThrow();
    expect(read(pomPath)).toBe(before);
    expect(read(manifestPath)).toBe(manifest);
    write("src/components/SaveButton.vue", "<template><button @click=\"changed()\">Changed</button></template>");
    if (!options.generation) throw new Error("test requires generation");
    options.generation.playwright!.customPoms = { dir: "missing-custom-poms" };
    await expect(generate()).rejects.toThrow();
    expect(read(pomPath)).toBe(before);
    expect(read(manifestPath)).toBe(manifest);
  });

  it("supports explicit companion plugins and an app-owned Vue plugin", async () => {
    options.vuePluginOwnership = "external";
    let completed = false;
    await generateVuePoms(options, { root, logLevel: "silent", plugins: [vue(), {
      name: "companion-codegen",
      buildEnd() { completed = true; },
    }] });
    expect(completed).toBe(true);
    expect(exists("tests/playwright/__generated__/SaveButton.g.ts")).toBe(true);
  });

  it("rejects disabled generation", async () => {
    await expect(generateVuePoms({ generation: false })).rejects.toThrow("requires generation");
  });

  it("rejects missing source directories without pruning an earlier generation", async () => {
    await generate();
    options.injection = { viewsDir: "missing-views", componentDirs: [], layoutDirs: [] };
    await expect(generate()).rejects.toThrow("No configured source directories exist");
    expect(exists("tests/playwright/__generated__/SaveButton.g.ts")).toBe(true);
  });

  it("moves VTU and fixture outputs while preserving handwritten neighbors", async () => {
    await generate();
    write("tests/unit/__generated__/custom.ts", "handwritten");
    if (!options.generation) throw new Error("test requires generation");
    options.generation.vueTestUtils = { outDir: "new-unit-output" };
    options.generation.playwright!.fixtures = "setup/test-fixtures.ts";
    await generate();
    expect(exists("tests/unit/__generated__/SaveButton.vtu.g.ts")).toBe(false);
    expect(read("tests/unit/__generated__/custom.ts")).toBe("handwritten");
    expect(exists("tests/playwright/__generated__/fixtures.g.ts")).toBe(false);
    expect(exists("new-unit-output/SaveButton.vtu.g.ts")).toBe(true);
    expect(exists("setup/test-fixtures.ts")).toBe(true);
  });

  it("uses the existing router introspection for typed page navigation", async () => {
    fs.symlinkSync(fileURLToPath(new URL("../node_modules", import.meta.url)), path.join(root, "node_modules"), "dir");
    write("src/views/DetailView.vue", '<template><button @click="save()">Save</button></template>');
    write("src/router.ts", [
      'import { createRouter, createMemoryHistory } from "vue-router";',
      'import DetailView from "./views/DetailView.vue";',
      'export default () => createRouter({ history: createMemoryHistory(), routes: [',
      '  { name: "detail", path: "/details/:id", component: DetailView, props: (route) => ({ id: route.params.id }) },',
      '] });',
    ].join("\n"));
    if (!options.generation) throw new Error("test requires generation");
    options.generation.router = { entry: "src/router.ts" };
    await generate();
    const page = read("tests/playwright/__generated__/DetailView.g.ts");
    expect(page).toContain("async goTo(");
    expect(page).toContain("id: string");
    expect(page).toContain("detail");
  });

  it("rejects overlapping one-shot calls and releases the guard after completion", async () => {
    let started!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const first = generateVuePoms(options, { root, logLevel: "silent", plugins: [{
      name: "controlled-generation",
      async buildStart() { started(); await barrier; },
    }] });
    try {
      await entered;
      await expect(generate()).rejects.toThrow("Await the previous");
    }
    finally {
      release();
      await first;
    }
    await expect(generate()).resolves.toBeUndefined();
  });

  it("leaves outputs unchanged when an ordinary Vite build fails", async () => {
    await generate();
    const manifestPath = "tests/playwright/__generated__/.vue-pom-generator-outputs.json";
    const manifest = read(manifestPath);
    await expect(build({ configFile: false, root, logLevel: "silent",
      plugins: [...vuePomGenerator(options), { name: "build-failure", buildStart() { throw new Error("build failed"); } }],
      build: { write: false },
    })).rejects.toThrow("build failed");
    expect(read(manifestPath)).toBe(manifest);
    expect(exists("tests/playwright/__generated__/SaveButton.g.ts")).toBe(true);
  });
});
