// Run after npm run build:
// node --expose-gc scripts/repro-hmr-regeneration.mjs [components=100] [buttons=10] [--disabled]
// Add --expect-full-regeneration when running against an unpatched package build.
// Uses the built public package, a real Vite watcher, and disposable Vue fixtures.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import vue from "@vitejs/plugin-vue";
import { vuePomGenerator } from "@immense/vue-pom-generator";
import { createLogger, createServer } from "vite";

const componentCount = Number(process.argv[2] ?? 100);
const buttonCount = Number(process.argv[3] ?? 10);
const disabled = process.argv.includes("--disabled");
const expectFullRegeneration = process.argv.includes("--expect-full-regeneration");
assert(Number.isInteger(componentCount) && componentCount >= 2);
assert(Number.isInteger(buttonCount) && buttonCount >= 1);
assert(globalThis.gc, "Run with --expose-gc to compare each phase after garbage collection");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "vue-pom-hmr-repro-"));
const sourceDir = path.join(root, "src/components");
fs.mkdirSync(sourceDir, { recursive: true });
fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
function makeTemplate(firstAction = "action0", firstLabel = "Action 0") {
  const actions = Array.from({ length: buttonCount }, (_, i) => i === 0 ? firstAction : `action${i}`);
  const declarations = actions.map(action => `function ${action}() {}`).join("\n");
  const buttons = actions.map((action, i) => `<button @click="${action}">${i === 0 ? firstLabel : `Action ${i}`}</button>`).join("\n");
  return `<script setup>\n${declarations}\n</script>\n<template><div>\n${buttons}\n</div></template>\n`;
}
const template = makeTemplate();
for (let i = 0; i < componentCount; i++) {
  fs.writeFileSync(path.join(sourceDir, `Widget${i}.vue`), template);
}
const editedFile = path.join(sourceDir, "Widget0.vue");
const outputPrefix = `${path.join(root, "tests")}${path.sep}`;
const expectedPlaywrightFiles = new Set(Array.from({ length: componentCount }, (_, i) => path.join("tests/playwright/__generated__", `Widget${i}.g.ts`)));
const outputContents = new Map();
const reports = [];
let phase;
let generationDone;
let generationFailed;
let server;
const originalWrite = fs.writeFileSync;
const originalRead = fs.readFileSync;
const originalUnlink = fs.unlinkSync;
const originalRename = fs.renameSync;
const pendingWrites = new Map();
const mib = bytes => +(bytes / 1024 / 1024).toFixed(1);

// A worker samples process-wide RSS while synchronous code generation blocks the
// main event loop. The worker's own memory is included in both baseline and peak.
const rss = new Int32Array(new SharedArrayBuffer(4));
const sampler = new Worker(`
  const { parentPort, workerData } = require("node:worker_threads");
  const rss = new Int32Array(workerData);
  setInterval(() => {
    const kb = Math.ceil(process.memoryUsage.rss() / 1024);
    if (kb > Atomics.load(rss, 0)) Atomics.store(rss, 0, kb);
  }, 5);
  parentPort.postMessage("ready");
`, { eval: true, workerData: rss.buffer });
await new Promise(resolve => sampler.once("message", resolve));

function observeMemory() {
  phase.observedPeakHeapBytes = Math.max(phase.observedPeakHeapBytes, process.memoryUsage().heapUsed);
}

fs.readFileSync = function (file, ...args) {
  if (phase && typeof file === "string" && file.startsWith(sourceDir) && file.endsWith(".vue")) {
    phase.vueFilesRead.add(path.basename(file));
    observeMemory();
  }
  return originalRead.call(this, file, ...args);
};
function recordOutput(file, text) {
  const relative = path.relative(root, file);
  phase.writes.push(relative);
  if (outputContents.get(relative) === text) phase.unchangedWrites++;
  outputContents.set(relative, text);
  observeMemory();
}
fs.writeFileSync = function (file, content, ...args) {
  if (phase && typeof file === "string" && file.startsWith(outputPrefix)) {
    const text = String(content);
    if (file.endsWith(".tmp")) pendingWrites.set(file, text);
    else recordOutput(file, text);
    observeMemory();
  }
  return originalWrite.call(this, file, content, ...args);
};
fs.renameSync = function (from, to) {
  const result = originalRename.call(this, from, to);
  if (phase && pendingWrites.has(from)) {
    recordOutput(to, pendingWrites.get(from));
    pendingWrites.delete(from);
  }
  return result;
};
fs.unlinkSync = function (file, ...args) {
  if (phase && typeof file === "string" && file.startsWith(outputPrefix)) phase.deletes++;
  return originalUnlink.call(this, file, ...args);
};

const logger = createLogger("info", { allowClearScreen: false });
const originalInfo = logger.info.bind(logger);
const originalError = logger.error.bind(logger);
logger.info = (message, options) => {
  if (phase && message.includes("[vue-pom-generator]")) phase.logs.push(message);
  originalInfo(message, options);
  if (message.includes("[vue-pom-generator] batched:") || message.includes("[vue-pom-generator] max-wait:")) generationDone?.();
};
logger.error = (message, options) => {
  originalError(message, options);
  generationFailed?.(new Error(message));
};

function startPhase(name) {
  globalThis.gc();
  const memory = process.memoryUsage();
  Atomics.store(rss, 0, Math.ceil(memory.rss / 1024));
  phase = {
    name, started: performance.now(), cpu: process.cpuUsage(),
    baselineHeapBytes: memory.heapUsed, baselineRssBytes: memory.rss,
    observedPeakHeapBytes: memory.heapUsed,
    writes: [], unchangedWrites: 0, deletes: 0, vueFilesRead: new Set(), logs: [],
  };
}

function endPhase() {
  observeMemory();
  const cpu = process.cpuUsage(phase.cpu);
  const report = {
    phase: phase.name,
    elapsedMs: +(performance.now() - phase.started).toFixed(1),
    cpuMs: +((cpu.user + cpu.system) / 1000).toFixed(1),
    uniqueVueFilesRead: phase.vueFilesRead.size,
    outputWrites: phase.writes.length,
    unchangedWrites: phase.unchangedWrites,
    outputDeletes: phase.deletes,
    playwrightComponentWrites: phase.writes.filter(file => expectedPlaywrightFiles.has(file)).length,
    unrelatedComponentRewritten: phase.writes.includes(path.join("tests/playwright/__generated__/Widget1.g.ts")),
    baselineHeapMiB: mib(phase.baselineHeapBytes),
    observedPeakHeapMiB: mib(phase.observedPeakHeapBytes),
    baselineRssMiB: mib(phase.baselineRssBytes),
    sampledPeakRssMiB: mib(Atomics.load(rss, 0) * 1024),
    logs: phase.logs,
  };
  reports.push(report);
  console.log(JSON.stringify(report, null, 2));
  phase = undefined;
  return report;
}

async function edit(name, source) {
  startPhase(name);
  let timeout;
  const completed = new Promise((resolve, reject) => {
    generationDone = resolve;
    generationFailed = reject;
    timeout = setTimeout(() => reject(new Error("Timed out waiting for real Vite HMR generation")), 120_000);
  });
  fs.writeFileSync(editedFile, source);
  try {
    await completed;
  }
  finally {
    clearTimeout(timeout);
    generationDone = undefined;
    generationFailed = undefined;
  }
  return endPhase();
}

try {
  startPhase("startup");
  server = await createServer({
    root,
    configFile: false,
    customLogger: logger,
    plugins: disabled ? [vue(), {
      name: "repro-observe-disabled-hmr",
      handleHotUpdate(ctx) {
        if (ctx.file === editedFile) generationDone?.();
      },
    }] : vuePomGenerator({
      logging: { verbosity: "info" },
      generation: {
        outDir: path.join(root, "tests/playwright/__generated__"),
        emit: ["ts", "csharp"],
        playwright: { outputStructure: "split", fixtures: true },
        vueTestUtils: { outDir: path.join(root, "tests/unit/__generated__") },
      },
    }),
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { host: "127.0.0.1", port: 0, ws: false },
  });
  await server.listen();
  endPhase();
  await delay(300); // Let the initial filesystem watch settle before editing.
  const cosmetic = await edit("label-only edit", makeTemplate("action0", "Updated label"));
  const semantic = await edit("handler rename", makeTemplate("renamedAction", "Updated label"));
  if (!disabled) {
    if (expectFullRegeneration) {
      assert.equal(cosmetic.playwrightComponentWrites, componentCount);
      assert.equal(cosmetic.unchangedWrites, cosmetic.outputWrites);
      assert.equal(semantic.unrelatedComponentRewritten, true);
    }
    else {
      assert.equal(cosmetic.outputWrites, 0, "A label-only edit must not rewrite generated output");
      assert.equal(semantic.playwrightComponentWrites, 1, "Only the changed component POM should be rewritten");
      assert.equal(semantic.unrelatedComponentRewritten, false, "Unrelated Widget1 must stay untouched");
      assert.equal(semantic.unchangedWrites, 0, "Identical outputs must not be rewritten");
    }
  }
  console.log(`RESULT ${JSON.stringify({ componentCount, buttonCount, disabled, node: process.version, reports })}`);
}
finally {
  if (server) await server.close();
  await sampler.terminate();
  fs.writeFileSync = originalWrite;
  fs.readFileSync = originalRead;
  fs.unlinkSync = originalUnlink;
  fs.renameSync = originalRename;
  fs.rmSync(root, { recursive: true, force: true });
}
