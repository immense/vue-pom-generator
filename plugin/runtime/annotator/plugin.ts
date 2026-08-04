import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { HtmlTagDescriptor, Plugin } from "vite";

import type { OutputDetail } from "./format";

export interface ResolvedAnnotatorUiOptions {
  enabled: boolean;
  sourceAttribute: string;
  metadataAttributePrefix: string;
  outputDetail: OutputDetail;
  copyToClipboard: boolean;
  showComponentTree: boolean;
}

const ANNOTATOR_CLIENT_VIRTUAL_ID = "virtual:vue-pom-generator/annotator-client";
const ANNOTATOR_CLIENT_RESOLVED_ID = `\0${ANNOTATOR_CLIENT_VIRTUAL_ID}`;
const DEFAULT_ENTRY_SUFFIXES = [
  "/src/main.ts",
  "/src/main.js",
  "/src/main.mts",
  "/src/main.tsx",
  "/src/main.jsx",
];

/**
 * Normalize Windows backslash path separators to POSIX forward slashes.
 *
 * Used to build Vite `/@fs/` import URLs and to compare entry-path suffixes
 * consistently across platforms. This is path-separator normalization, not
 * source-code parsing.
 *
 * @example
 * normalizePathSeparators("src\\widgets\\Item.vue") // "src/widgets/Item.vue"
 * normalizePathSeparators("src/widgets/Item.vue") // "src/widgets/Item.vue"
 */
function normalizePathSeparators(filePath: string): string {
  /* eslint-disable no-restricted-syntax -- normalizing path separators, not parsing source code */
  return filePath.replace(/\\/g, "/");
  /* eslint-enable no-restricted-syntax */
}

function toFsImportPath(filePath: string): string {
  return `/@fs/${normalizePathSeparators(filePath)}`;
}

function resolveAnnotatorClientPath(): string {
  const candidates = [
    fileURLToPath(new URL("./client.ts", import.meta.url)),
    fileURLToPath(new URL("../plugin/runtime/annotator/client.ts", import.meta.url)),
  ];

  const resolved = candidates.find(candidate => fs.existsSync(candidate));
  if (!resolved) {
    throw new Error("[vue-pom-generator] Unable to locate annotator client source.");
  }
  return path.resolve(resolved);
}

export function createAnnotatorUiPlugin(options: ResolvedAnnotatorUiOptions): Plugin {
  const clientPath = resolveAnnotatorClientPath();
  const clientImportPath = toFsImportPath(clientPath);
  const clientOptions = JSON.stringify({
    sourceAttribute: options.sourceAttribute,
    metadataAttributePrefix: options.metadataAttributePrefix,
    outputDetail: options.outputDetail,
    copyToClipboard: options.copyToClipboard,
    showComponentTree: options.showComponentTree,
  });

  return {
    name: "vue-pom-generator:annotator-ui",
    apply: "serve",
    resolveId(id) {
      if (id === ANNOTATOR_CLIENT_VIRTUAL_ID) {
        return ANNOTATOR_CLIENT_RESOLVED_ID;
      }
    },
    load(id) {
      if (id !== ANNOTATOR_CLIENT_RESOLVED_ID) {
        return null;
      }

      return [
        `import { mountAnnotatorClient } from ${JSON.stringify(clientImportPath)};`,
        `mountAnnotatorClient(${clientOptions});`,
        "",
      ].join("\n");
    },
    transform(code, id) {
      if (!options.enabled) {
        return null;
      }

      const normalizedId = normalizePathSeparators(id);
      if (!DEFAULT_ENTRY_SUFFIXES.some(suffix => normalizedId.endsWith(suffix))) {
        return null;
      }

      if (code.includes(ANNOTATOR_CLIENT_VIRTUAL_ID)) {
        return null;
      }

      return {
        code: `import ${JSON.stringify(ANNOTATOR_CLIENT_VIRTUAL_ID)};\n${code}`,
        map: null,
      };
    },
    transformIndexHtml() {
      if (!options.enabled) {
        return undefined;
      }

      const tag: HtmlTagDescriptor = {
        tag: "script",
        attrs: { type: "module" },
        children: `import ${JSON.stringify(ANNOTATOR_CLIENT_VIRTUAL_ID)};`,
        injectTo: "body",
      };

      return [tag];
    },
  };
}

// Exposed for unit tests. Pure helper (no I/O).
export const __internal = {
  normalizePathSeparators,
};
