import { defineConfig } from "vite";
import { vuePomGenerator } from "@immense/vue-pom-generator";

export default defineConfig({
  plugins: vuePomGenerator({
    generation: false,
    injection: {
      componentDirs: ["../shared/ui/src/components"],
      existingIdBehavior: "preserve",
    },
    runtime: {
      annotator: {
        enabled: true,
        sourceRoot: "..",
        ui: { enabled: true, outputDetail: "standard", copyToClipboard: true },
      },
    },
  }),
});
