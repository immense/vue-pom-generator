import type {
  ExistingIdBehavior,
  MissingSemanticNameBehavior,
  PlaywrightOutputStructure,
  PomNameCollisionBehavior,
  RouterModuleShimDefinition,
} from "./types";

export interface ResolvedCustomPomAttachmentConfig {
  className: string;
  propertyName: string;
  attachWhenUsesComponents: string[];
  attachTo?: "views" | "components" | "both" | "pagesAndComponents";
  flatten?: boolean;
}

export interface ResolvedGenerationSupportOptions {
  outDir: string;
  emitLanguages: Array<"ts" | "csharp">;
  typescriptOutputStructure: PlaywrightOutputStructure;
  csharp?: {
    namespace?: string;
  };
  generateFixtures?: boolean | string | { outDir?: string };
  customPomAttachments: ResolvedCustomPomAttachmentConfig[];
  customPomDir: string;
  requireCustomPomDir: boolean;
  customPomImportAliases?: Record<string, string>;
  customPomImportNameCollisionBehavior: "error" | "alias";
  nameCollisionBehavior: PomNameCollisionBehavior;
  missingSemanticNameBehavior: MissingSemanticNameBehavior;
  existingIdBehavior: ExistingIdBehavior;
  testIdAttribute: string;
  accessibilityAudit: boolean;
  routerAwarePoms: boolean;
  routerEntry?: string;
  routerType?: "vue-router" | "nuxt";
  routerModuleShims?: Record<string, RouterModuleShimDefinition>;
}

export function resolveGenerationSupportOptions(
  options: Partial<ResolvedGenerationSupportOptions>,
): ResolvedGenerationSupportOptions {
  return {
    outDir: (options.outDir ?? "tests/playwright/__generated__").trim(),
    emitLanguages: options.emitLanguages?.length ? options.emitLanguages : ["ts"],
    typescriptOutputStructure: options.typescriptOutputStructure ?? "aggregated",
    csharp: options.csharp,
    generateFixtures: options.generateFixtures,
    customPomAttachments: options.customPomAttachments ?? [],
    customPomDir: options.customPomDir ?? "tests/playwright/pom/custom",
    requireCustomPomDir: options.requireCustomPomDir ?? false,
    customPomImportAliases: options.customPomImportAliases,
    customPomImportNameCollisionBehavior: options.customPomImportNameCollisionBehavior ?? "error",
    nameCollisionBehavior: options.nameCollisionBehavior ?? "error",
    missingSemanticNameBehavior: options.missingSemanticNameBehavior ?? "error",
    existingIdBehavior: options.existingIdBehavior ?? "error",
    testIdAttribute: (options.testIdAttribute ?? "data-testid").trim() || "data-testid",
    accessibilityAudit: options.accessibilityAudit ?? false,
    routerAwarePoms: options.routerAwarePoms ?? false,
    routerEntry: options.routerEntry,
    routerType: options.routerType ?? "vue-router",
    routerModuleShims: options.routerModuleShims,
  };
}
