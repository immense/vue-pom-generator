import fs from "node:fs";
import { camelize } from "@vue/shared";
import { annotatorSourcePath } from "../../annotator-source";
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
function findExportedComponent(code: string): { name: string; fileRange?: [number, number] } | undefined {
  const program = parse(code, { sourceType: "module", plugins: ["typescript", "jsx"] }).program;
  const exported = program.body.find(node => node.type === "ExportDefaultDeclaration");
  if (!exported) {
    return undefined;
  }

  const declaration = exported.declaration;
  if (declaration.type === "Identifier") {
    return { name: declaration.name };
  }

  if (declaration.type === "CallExpression" && declaration.arguments[0]?.type === "Identifier") {
    const attachedProps = declaration.arguments[1];
    const fileProp = attachedProps?.type === "ArrayExpression"
      ? attachedProps.elements.find(prop => prop?.type === "ArrayExpression" && prop.elements[0]?.type === "StringLiteral" && prop.elements[0].value === "__file")
      : undefined;
    const fileValue = fileProp?.type === "ArrayExpression" ? fileProp.elements[1] : undefined;
    return {
      name: declaration.arguments[0].name,
      fileRange: fileValue?.type === "StringLiteral" && fileValue.start != null && fileValue.end != null
        ? [fileValue.start, fileValue.end] : undefined,
    };
  }

  return undefined;
}

/** Consume usage metadata as a prop so outer fallthrough cannot replace a nested usage. */
function addComponentMetadata(code: string, file: string, usageAttribute?: string): string | undefined {
  const exported = findExportedComponent(code);
  if (!exported) {
    return undefined;
  }
  const component = exported.name;
  if (exported.fileRange) {
    const [start, end] = exported.fileRange;
    code = code.slice(0, start) + JSON.stringify(file) + code.slice(end);
  }
  const prop = usageAttribute && JSON.stringify(camelize(usageAttribute));
  return `${code}\n${component}.__file = ${JSON.stringify(file)};\n`
    + (prop ? `${component}.props = Array.isArray(${component}.props) ? ${component}.props.concat(${prop}) : { ...${component}.props, [${prop}]: String };\n` : "");
}

/** Keep component paths and usage props consistent in dev, client builds, and SSR. */
export function createAnnotatorSourcePlugin(options: {
  enabled: boolean;
  componentLinks: boolean;
  isFileInScope: (filename: string) => boolean;
  getSourceRoot: () => string;
  metadataAttributePrefix: string;
}): Plugin {
  return {
    name: "vue-pom-generator:annotator-sources",
    enforce: "post",
    config() {
      return options.enabled && options.componentLinks ? { define: { __VUE_PROD_DEVTOOLS__: true } } : undefined;
    },
    transform(code, id) {
      // A component's own module, not one of its ?vue&type=... blocks.
      if (!options.enabled || !id.endsWith(".vue")) {
        return null;
      }
      const updated = addComponentMetadata(code, annotatorSourcePath(id, options.getSourceRoot()), options.isFileInScope(id) ? `${options.metadataAttributePrefix}-usage` : undefined);
      return updated === undefined ? null : { code: updated, map: null };
    },
  };
}

// Exposed for unit tests. Pure helpers (no I/O).
export const __internal = {
  normalizePathSeparators,
  addComponentMetadata,
};
