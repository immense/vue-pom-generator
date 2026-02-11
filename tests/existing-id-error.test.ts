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
        scanDirs: ["."],
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
    const expectedError = "[vue-pom-generator] Found existing data-testid while existingIdBehavior=\"error\".";

    await expect((metadataPlugin.transform as any).call({}, code, id)).rejects.toThrow(expectedError);
  });
});
