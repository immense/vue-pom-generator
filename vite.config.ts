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
        ]);

        return (id: string) => id.startsWith("node:") || externals.has(id);
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
