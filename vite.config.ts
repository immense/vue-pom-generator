import { defineConfig } from "vite";

export default defineConfig({
  build: {
    // This package is a Vite plugin; it must run in Node.
    ssr: "./index.ts",
    sourcemap: true,
    emptyOutDir: true,
    rollupOptions: {
      external: (() => {
        const externals = new Set<string>([
          "vite",
          "@vitejs/plugin-vue",
          "jsdom",
          "vue",
          "@vue/compiler-core",
          "@vue/compiler-dom",
          "@vue/compiler-sfc",
          "@vue/shared",
          "@babel/types",
          "vite-plugin-virtual",
        ]);

        return (id: string) => id.startsWith("node:") || externals.has(id);
      })(),
      output: [
        {
          format: "es",
          entryFileNames: "index.mjs",
        },
        {
          format: "cjs",
          entryFileNames: "index.cjs",
          exports: "named",
        },
      ],
    },
  },
});
