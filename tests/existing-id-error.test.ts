import { describe, it, expect } from "vitest";
import { createVuePomGeneratorPlugins } from "../index";
import path from "node:path";
import process from "node:process";
import type { Plugin } from "vite";

describe("existingIdBehavior: 'error'", () => {
  it("halts compilation (throws) when an existing data-testid is found", async () => {
    const plugins = createVuePomGeneratorPlugins({
      injection: {
        existingIdBehavior: "error",
        componentDirs: ["."],
      },
      generation: false,
    });

    const metadataPlugin = plugins.find((p): p is Plugin => 
      !!(p && typeof p === "object" && "name" in p && p.name === "vue-pom-generator-metadata-collector")
    );
    
    if (!metadataPlugin || typeof metadataPlugin.transform !== "function") {
      throw new Error("Could not find metadata collector plugin");
    }
    
    // Create a mock SFC with an existing data-testid
    const code = `<template><button data-testid="existing">Click me</button></template>`;
    const id = path.resolve(process.cwd(), "TestComponent.vue");

    // Using string matching instead of RegExp literal to satisfy linting rules.
    const expectedError = "remove-existing-test-id-attributes rule and --fix";

    await expect((metadataPlugin.transform as any).call({}, code, id)).rejects.toThrow(expectedError);
  });
});

describe("existingIdBehavior: 'preserve'", () => {
  it("halts compilation when preserving an existing data-testid on wrappers that require option-data-testid-prefix", async () => {
    const plugins = createVuePomGeneratorPlugins({
      injection: {
        existingIdBehavior: "preserve",
        componentDirs: ["."],
        nativeWrappers: {
          ImmyRadioGroup: {
            role: "radio",
            requiresOptionDataTestIdPrefix: true,
          },
        },
      },
      generation: false,
    });

    const metadataPlugin = plugins.find((p): p is Plugin =>
      !!(p && typeof p === "object" && "name" in p && p.name === "vue-pom-generator-metadata-collector")
    );

    if (!metadataPlugin || typeof metadataPlugin.transform !== "function") {
      throw new Error("Could not find metadata collector plugin");
    }

    const code = `<template><ImmyRadioGroup data-testid="database-type" v-model="selectedGroup" /></template>`;
    const id = path.resolve(process.cwd(), "TestComponent.vue");

    const expectedError = "existingIdBehavior=\"preserve\" cannot safely preserve nested option ids";

    await expect((metadataPlugin.transform as any).call({}, code, id)).rejects.toThrow(expectedError);
  });
});
