// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Plugin } from "vite";
import { describe, expect, it } from "vitest";

import { createVuePomGeneratorPlugins } from "../index";

interface TestViteLogger {
  info: () => void;
  warn: () => void;
  error: () => void;
}

function runConfigResolved(plugins: unknown[], root: string) {
  const configPlugin = plugins
    .map((p) => {
      if (typeof p !== "object" || !p || !("name" in p))
        return null;
      return p as { name?: string; configResolved?: (config: { root: string; logger: TestViteLogger; plugins: Array<{ name: string; api?: { options?: unknown } }> }) => void };
    })
    .find(p => p?.name === "vue-pom-generator-config");

  if (!configPlugin?.configResolved)
    throw new Error("config plugin not found");

  const viteVuePlugin = {
    name: "vite:vue",
    api: {
      options: {},
    },
  };

  configPlugin.configResolved({
    root,
    logger: {
      info() {},
      warn() {},
      error() {},
    },
    plugins: [
      viteVuePlugin,
      { name: "vue-pom-generator-config" },
      { name: "vue-pom-generator-metadata-collector" },
      { name: "vue-pom-generator-build" },
      { name: "vue-pom-generator-dev" },
    ],
  });
}

function getPlugin(plugins: unknown[], name: string): Plugin {
  const plugin = plugins.find((p): p is Plugin =>
    !!(p && typeof p === "object" && "name" in p && p.name === name)
  );

  if (!plugin) {
    throw new Error(`Could not find plugin '${name}'`);
  }

  return plugin;
}

function createNuxtPlugins(outDir: string) {
  return createVuePomGeneratorPlugins({
    injection: {
      scanDirs: ["app"],
      viewsDir: "app/pages",
    },
    generation: {
      outDir,
      emit: ["csharp"],
      csharp: { namespace: "Test.Generated" },
      router: { type: "nuxt" },
    },
    logging: { verbosity: "silent" },
  });
}

describe("Nuxt query-suffixed SFC ids", () => {
  it("still generate aggregated page classes during build", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vue-pom-generator-nuxt-query-"));
    const outDir = path.join(tempRoot, "generated", "pom");
    const homeDir = path.join(tempRoot, "app", "pages", "home");
    const homeFile = path.join(homeDir, "index.vue");
    const code = `<template><button data-testid="home-open-create-new-matter">New Client</button></template>`;

    fs.mkdirSync(homeDir, { recursive: true });
    fs.writeFileSync(homeFile, code);

    try {
      const plugins = createNuxtPlugins(outDir);

      runConfigResolved(plugins, tempRoot);

      const metadataPlugin = getPlugin(plugins, "vue-pom-generator-metadata-collector");
      const buildPlugin = getPlugin(plugins, "vue-pom-generator-build");

      if (typeof metadataPlugin.transform !== "function" || typeof buildPlugin.buildEnd !== "function") {
        throw new Error("Required plugin hooks are missing");
      }

      await (metadataPlugin.transform as any).call({}, code, `${homeFile}?macro=true`);
      await (buildPlugin.buildEnd as any).call({}, undefined);

      const generatedFile = path.join(outDir, "page-object-models.g.cs");
      expect(fs.existsSync(generatedFile)).toBe(true);

      const generated = fs.readFileSync(generatedFile, "utf8");
      expect(generated).toContain("public partial class HomeIndex : BasePage");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("shares build state across separate Nuxt plugin instances", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vue-pom-generator-nuxt-shared-"));
    const outDir = path.join(tempRoot, "generated", "pom");
    const homeDir = path.join(tempRoot, "app", "pages", "home");
    const homeFile = path.join(homeDir, "index.vue");
    const code = `<template>
  <div>
    <AylaButton id="btnNewMatter" type="button" @click="openCreateNewMatter">New Client</AylaButton>
    <input id="txbClientName" v-model="state.clientName" type="text" />
  </div>
</template>`;

    fs.mkdirSync(homeDir, { recursive: true });
    fs.writeFileSync(homeFile, code);

    try {
      const transformPlugins = createNuxtPlugins(outDir);
      const buildPlugins = createNuxtPlugins(outDir);

      runConfigResolved(transformPlugins, tempRoot);
      runConfigResolved(buildPlugins, tempRoot);

      const metadataPlugin = getPlugin(transformPlugins, "vue-pom-generator-metadata-collector");
      const buildPlugin = getPlugin(buildPlugins, "vue-pom-generator-build");

      if (typeof metadataPlugin.transform !== "function" || typeof buildPlugin.buildEnd !== "function") {
        throw new Error("Required plugin hooks are missing");
      }

      await (metadataPlugin.transform as any).call({}, code, `${homeFile}?macro=true`);
      await (buildPlugin.buildEnd as any).call({}, undefined);

      const generatedFile = path.join(outDir, "page-object-models.g.cs");
      expect(fs.existsSync(generatedFile)).toBe(true);

      const generated = fs.readFileSync(generatedFile, "utf8");
      expect(generated).toContain("OpenCreateNewMatterButton");
      expect(generated).toContain("TxbClientNameInput");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("does not let a later smaller Nuxt build pass clobber a richer earlier pass", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vue-pom-generator-nuxt-build-richness-"));
    const outDir = path.join(tempRoot, "generated", "pom");
    const homeDir = path.join(tempRoot, "app", "pages", "home");
    const homeFile = path.join(homeDir, "index.vue");
    const richCode = `<template>
  <div>
    <AylaButton id="btnNewMatter" type="button" @click="openCreateNewMatter">New Client</AylaButton>
    <input id="txbClientName" v-model="state.clientName" type="text" />
  </div>
</template>`;
    const smallerCode = `<template>
  <div>
    <AylaButton id="btnNewMatter" type="button" @click="openCreateNewMatter">New Client</AylaButton>
  </div>
</template>`;

    fs.mkdirSync(homeDir, { recursive: true });
    fs.writeFileSync(homeFile, richCode);

    try {
      const firstPassPlugins = createNuxtPlugins(outDir);
      const secondPassPlugins = createNuxtPlugins(outDir);

      runConfigResolved(firstPassPlugins, tempRoot);
      runConfigResolved(secondPassPlugins, tempRoot);

      const firstMetadataPlugin = getPlugin(firstPassPlugins, "vue-pom-generator-metadata-collector");
      const firstBuildPlugin = getPlugin(firstPassPlugins, "vue-pom-generator-build");
      const secondMetadataPlugin = getPlugin(secondPassPlugins, "vue-pom-generator-metadata-collector");
      const secondBuildPlugin = getPlugin(secondPassPlugins, "vue-pom-generator-build");

      if (
        typeof firstMetadataPlugin.transform !== "function"
        || typeof firstBuildPlugin.buildEnd !== "function"
        || typeof secondMetadataPlugin.transform !== "function"
        || typeof secondBuildPlugin.buildEnd !== "function"
      ) {
        throw new Error("Required plugin hooks are missing");
      }

      await (firstMetadataPlugin.transform as any).call({}, richCode, `${homeFile}?macro=true`);
      await (firstBuildPlugin.buildEnd as any).call({}, undefined);

      const generatedFile = path.join(outDir, "page-object-models.g.cs");
      expect(fs.existsSync(generatedFile)).toBe(true);

      let generated = fs.readFileSync(generatedFile, "utf8");
      expect(generated).toContain("OpenCreateNewMatterButton");
      expect(generated).toContain("TxbClientNameInput");

      await (secondMetadataPlugin.transform as any).call({}, smallerCode, `${homeFile}?macro=true`);
      await (secondBuildPlugin.buildEnd as any).call({}, undefined);

      generated = fs.readFileSync(generatedFile, "utf8");
      expect(generated).toContain("OpenCreateNewMatterButton");
      expect(generated).toContain("TxbClientNameInput");
    }
    finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
