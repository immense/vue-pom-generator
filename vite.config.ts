import { defineConfig } from "vite";

export default defineConfig({
  build: {
    // This package is a Vite plugin; it must run in Node.
    ssr: true,
    sourcemap: true,
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: "./index.ts",
        // eslint sub-export: import "@immense/vue-pom-generator/eslint"
        "eslint/index": "./eslint/index.ts",
        // Playwright failure reporter: import "@immense/vue-pom-generator/playwright/reporter"
        "playwright/reporter": "./playwright/reporter.ts",
        // Public BasePage runtime for handwritten POMs.
        "playwright/runtime": "./class-generation/base-page.ts",
        // browser-safe router bridge: import "@immense/vue-pom-generator/router"
        router: "./router-bridge.ts",
      },
      external: (() => {
        const externals = new Set<string>([
          "@babel/parser",
          "@babel/types",
          "@vitejs/plugin-vue",
          "@vue/compiler-core",
          "@vue/compiler-dom",
          "@vue/compiler-sfc",
          "vite",
          "playwright",
          "@playwright/test",
        ]);

        return (id: string) => id.startsWith("node:")
          || id.startsWith("playwright/")
          || id.startsWith("@playwright/test/")
          || externals.has(id);
      })(),
      output: [
        {
          format: "es",
          entryFileNames: "[name].mjs",
        },
        {
          format: "cjs",
          entryFileNames: "[name].cjs",
          exports: "named",
        },
      ],
    },
  },
});
