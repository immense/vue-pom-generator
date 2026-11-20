import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "@babel/parser";
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
    apply(config, { command }) {
      return command === "serve" || !config.build?.ssr;
    },
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
    transform(code, id, transformOptions) {
      if (!options.enabled || transformOptions?.ssr) {
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
    transformIndexHtml: {
      order: "pre",
      handler() {
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
    },
  };
}

/**
 * The identifier holding a compiled single-file component, from plugin-vue's output: `export default _sfc_main`, or
 * `export default _export_sfc(_sfc_main, [...])`, which sets its options on `_sfc_main` and returns it. Undefined when the
 * module exports something else.
 */
function findExportedComponent(code: string): string | undefined {
  const program = parse(code, { sourceType: "module", plugins: ["typescript", "jsx"] }).program;
  const exported = program.body.find(node => node.type === "ExportDefaultDeclaration");
  if (!exported) {
    return undefined;
  }

  const declaration = exported.declaration;
  if (declaration.type === "Identifier") {
    return declaration.name;
  }

  if (declaration.type === "CallExpression" && declaration.arguments[0]?.type === "Identifier") {
    return declaration.arguments[0].name;
  }

  return undefined;
}

/**
 * `code`, a compiled single-file component, with its source path set as `__file`, or undefined when it exports no
 * component. The assignment is appended, so no existing code moves and its source map still applies.
 */
function addComponentSourcePath(code: string, file: string): string | undefined {
  const component = findExportedComponent(code);
  return component ? `${code}\n${component}.__file = ${JSON.stringify(file)};\n` : undefined;
}

/**
 * In a build, gives every compiled single-file component its source path (`__file`, relative to the Vite root), as
 * plugin-vue does on the dev server. The annotator names the component behind an element from it, so a built app, such
 * as a preview deployment, shows the source of static text, slot content and teleported content too.
 */
export function createAnnotatorSourcePlugin(options: { enabled: boolean }): Plugin {
  let root = process.cwd();
  return {
    name: "vue-pom-generator:annotator-sources",
    enforce: "post",
    apply: "build",
    configResolved(config) {
      root = config.root;
    },
    transform(code, id, transformOptions) {
      // A component's own module, `Foo.vue`, not one of its `Foo.vue?vue&type=...` blocks.
      if (!options.enabled || transformOptions?.ssr || !id.endsWith(".vue")) {
        return null;
      }

      const updated = addComponentSourcePath(code, normalizePathSeparators(path.relative(root, id)));
      return updated === undefined ? null : { code: updated, map: null };
    },
  };
}

// Exposed for unit tests. Pure helpers (no I/O).
export const __internal = {
  normalizePathSeparators,
  addComponentSourcePath,
};
