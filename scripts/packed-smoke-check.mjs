import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function run(cmd, args, options = {}) {
  return execFileSync(cmd, args, {
    stdio: "inherit",
    ...options,
  });
}

function runCapture(cmd, args, options = {}) {
  return execFileSync(cmd, args, {
    stdio: ["ignore", "pipe", "inherit"],
    encoding: "utf8",
    ...options,
  });
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(scriptDir, "..");

const peerVite = "7.3.1";
const peerVue = "3.5.22";
const peerPluginVue = "6.0.1";
const consumerPlaywrightTest = "1.61.0";
const consumerVueTestUtils = "2.4.11";
const consumerTypeScript = "5.9.2";

function lastNonEmptyLine(value) {
  // Avoid regex and split/replace/match-style parsing (repo lint rule).
  let end = value.length;
  while (end > 0) {
    const ch = value[end - 1];
    if (ch === "\n" || ch === "\r" || ch === " " || ch === "\t") {
      end -= 1;
      continue;
    }
    break;
  }

  let start = end;
  while (start > 0) {
    const ch = value[start - 1];
    if (ch === "\n" || ch === "\r") {
      break;
    }
    start -= 1;
  }

  return value.slice(start, end);
}

let tempRoot = "";

try {
  // Ensure dist is current.
  run("npm", ["run", "build"], { cwd: packageDir });

  // Create a packed tarball.
  const packOutRaw = runCapture("npm", ["pack", "--silent"], { cwd: packageDir });
  if (!packOutRaw) {
    throw new Error("npm pack produced no output");
  }

  const tarballName = lastNonEmptyLine(packOutRaw);
  if (!tarballName) {
    throw new Error(`Unable to parse npm pack output: ${packOutRaw}`);
  }
  const tarballPath = path.resolve(packageDir, tarballName);
  if (!fs.existsSync(tarballPath)) {
    throw new Error(`Packed tarball not found: ${tarballPath}`);
  }

  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vue-pom-generator-pack-"));
  fs.writeFileSync(
    path.join(tempRoot, "package.json"),
    JSON.stringify({ name: "vue-pom-generator-packed-smoke", private: true, type: "module" }, null, 2),
    "utf8",
  );

  // Install peers + the packed tarball as a consumer would.
  // Exercise the minimum supported Playwright Test peer as a consumer would.
  run(
    "npm",
    [
      "install",
      "--silent",
      "--no-audit",
      "--no-fund",
      `${tarballPath}`,
      `@playwright/test@${consumerPlaywrightTest}`,
      `vite@${peerVite}`,
      `vue@${peerVue}`,
      `@vitejs/plugin-vue@${peerPluginVue}`,
      `@vue/test-utils@${consumerVueTestUtils}`,
      `typescript@${consumerTypeScript}`,
    ],
    { cwd: tempRoot },
  );

  const nestedPlaywrightPath = path.join(
    tempRoot,
    "node_modules",
    "@immense",
    "vue-pom-generator",
    "node_modules",
    "playwright",
  );
  if (fs.existsSync(nestedPlaywrightPath)) {
    throw new Error(
      `Packed consumer install created a nested playwright copy at ${nestedPlaywrightPath}. `
      + "Relax the package peer range so downstream Playwright upgrades can dedupe cleanly.",
    );
  }

  // Verify we can import and create plugins.
  run(
    "node",
    [
      "-e",
      [
        "(async () => {",
        "  const m = await import('@immense/vue-pom-generator');",
        "  if (typeof m.createVuePomGeneratorPlugins !== 'function') {",
        "    throw new Error('Expected createVuePomGeneratorPlugins export');",
        "  }",
        "  const plugins = m.createVuePomGeneratorPlugins({ generation: false });",
        "  if (!Array.isArray(plugins)) {",
        "    throw new Error('Expected createVuePomGeneratorPlugins to return an array');",
        "  }",
        "  console.log('[packed-smoke] ok: plugins=', plugins.length);",
        "})();",
      ].join("\n"),
    ],
    { cwd: tempRoot },
  );

  // Verify handwritten POMs can consume the supported runtime entry point from a packed install.
  run(
    "node",
    [
      "-e",
      [
        "(async () => {",
        "  const runtime = await import('@immense/vue-pom-generator/playwright/runtime');",
        "  if (typeof runtime.BasePage !== 'function' || typeof runtime.ObjectId !== 'function') {",
        "    throw new Error('Expected public Playwright runtime exports');",
        "  }",
        "  console.log('[packed-smoke] ok: public Playwright runtime');",
        "})();",
      ].join("\n"),
    ],
    { cwd: tempRoot },
  );

  // Exercise Vue Test Utils generation through the packed Vite plugin, including the
  // package-owned runtime source copied into the consumer's generated directory.
  fs.mkdirSync(path.join(tempRoot, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(tempRoot, "index.html"),
    '<div id="app"></div><script type="module" src="/src/main.js"></script>\n',
    "utf8",
  );
  fs.writeFileSync(
    path.join(tempRoot, "src", "main.js"),
    'import { createApp } from "vue";\nimport App from "./App.vue";\ncreateApp(App).mount("#app");\n',
    "utf8",
  );
  fs.writeFileSync(
    path.join(tempRoot, "src", "App.vue"),
    '<script setup>\nfunction save() {}\n</script>\n<template><button @click="save">Save</button></template>\n',
    "utf8",
  );
  fs.writeFileSync(
    path.join(tempRoot, "vite.config.mjs"),
    [
      'import { defineConfig } from "vite";',
      'import { createVuePomGeneratorPlugins } from "@immense/vue-pom-generator";',
      "export default defineConfig({",
      "  plugins: createVuePomGeneratorPlugins({",
      '    injection: { viewsDir: "src", componentDirs: ["src"], layoutDirs: ["src"] },',
      '    generation: { outDir: "tests/playwright/__generated__", vueTestUtils: {} },',
      "  }),",
      "});",
    ].join("\n"),
    "utf8",
  );
  run("npx", ["vite", "build"], { cwd: tempRoot });

  const vueTestUtilsOutputDir = path.join(tempRoot, "tests", "unit", "__generated__");
  const generatedComponentObject = fs.readFileSync(
    path.join(vueTestUtilsOutputDir, "App.vtu.g.ts"),
    "utf8",
  );
  if (!generatedComponentObject.includes("async clickSave()")) {
    throw new Error("Packed plugin did not emit the expected Vue Test Utils action.");
  }
  const vueTestUtilsTypeScriptFiles = fs.readdirSync(vueTestUtilsOutputDir)
    .filter(file => file.endsWith(".ts"))
    .map(file => path.join(vueTestUtilsOutputDir, file));
  vueTestUtilsTypeScriptFiles.push(
    path.join(vueTestUtilsOutputDir, "_pom-runtime", "vue-test-utils-pom.ts"),
  );
  run("npx", [
    "tsc",
    "--noEmit",
    "--target",
    "ES2022",
    "--module",
    "ESNext",
    "--moduleResolution",
    "Bundler",
    "--lib",
    "ES2022,DOM",
    "--skipLibCheck",
    "true",
    "--verbatimModuleSyntax",
    "true",
    ...vueTestUtilsTypeScriptFiles,
  ], { cwd: tempRoot });
  console.log("[packed-smoke] ok: Vue Test Utils generation");

  // Cleanup tarball + temp workspace.
  fs.rmSync(tarballPath, { force: true });
  fs.rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = "";
}
catch (err) {
  if (tempRoot) {
    // Keep the temp folder for inspection.
    console.error(`[packed-smoke] failed; temp dir preserved at: ${tempRoot}`);
  }
  throw err;
}
