import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

import type { IComponentDependencies } from "../utils";
import { generateViewObjectModelMethodContent, generateFiles } from "../class-generation";

function writeFile(filePath: string, content: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function runTscNoEmit(files: string[], options?: { cwd?: string }) {
  const require = createRequire(import.meta.url);
  const tscPath = require.resolve("typescript/bin/tsc");

  const args = [
    tscPath,
    "--noEmit",
    "--pretty",
    "false",
    // Keep this focused on syntactic/structural validity of generated output.
    // We provide a small stub BasePage so the generated file can typecheck.
    "--target",
    "ES2022",
    "--module",
    "commonjs",
    "--moduleResolution",
    "node",
    "--skipLibCheck",
    "true",
    ...files,
  ];

  return spawnSync(process.execPath, args, {
    cwd: options?.cwd,
    encoding: "utf8",
  });
}

describe("generated output", () => {
  it("typechecks generated methods (tsc --noEmit)", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vue-pom-generator-"));

    const basePagePath = path.join(tempRoot, "BasePage.ts");
    writeFile(
      basePagePath,
      [
        "export type Fluent<T extends object> = T & PromiseLike<T>;",
        "export class BasePage {",
        "  public page: any;",
        "  public constructor(page?: any, _options?: { testIdAttribute?: string }) {",
        "    this.page = page;",
        "  }",
        "  protected fluent<T extends object>(_factory: () => Promise<T>): Fluent<T> {",
        "    throw new Error('not implemented');",
        "  }",
        "  protected locatorByTestId(_testId: string): any {",
        "    return null as any;",
        "  }",
        "  protected selectorForTestId(testId: string): string {",
        "    return `[data-testid=\"${testId}\"]`;",
        "  }",
        "  protected async clickByTestId(_testId: string, _annotationText: string = '', _wait: boolean = true): Promise<void> {}",
        "  protected async fillInputByTestId(_testId: string, _text: string, _annotationText: string = ''): Promise<void> {}",
        "  protected async selectVSelectByTestId(_testId: string, _value: string, _timeOut = 500, _annotationText: string = ''): Promise<void> {}",
        "  protected async animateCursorToElement(_selector: string, _executeClick = true, _delay = 100, _annotationText: string = '', _waitForInstrumentationEvent = true): Promise<void> {}",
        "}",
        "",
      ].join("\n"),
    );

    const componentName = "TestComponent";

    const formattedDataTestId = "TestComponent-${key}-Save-button";
    const methodsContent = generateViewObjectModelMethodContent(
      undefined,
      "Save",
      "button",
      formattedDataTestId,
      { key: "string" },
    );

    const deps: IComponentDependencies = {
      filePath: path.join(tempRoot, `${componentName}.vue`),
      childrenComponentSet: new Set(),
      usedComponentSet: new Set(),
      dataTestIdSet: new Set(),
      methodsContent,
      generatedMethods: new Map(),
      isView: false,
    };

    const componentHierarchyMap = new Map<string, IComponentDependencies>([[componentName, deps]]);
    const vueFilesPathMap = new Map<string, string>();

    const outDir = path.join(tempRoot, "out");

    await generateFiles(componentHierarchyMap, vueFilesPathMap, basePagePath, {
      outDir,
      projectRoot: tempRoot,
      singleFile: false,
    });

    const generatedFilePath = path.join(outDir, "Components", `${componentName}.g.ts`);
    expect(fs.existsSync(generatedFilePath)).toBe(true);

    const result = runTscNoEmit([generatedFilePath, basePagePath], { cwd: tempRoot });

    if (result.status !== 0) {
      const stdout = (result.stdout || "").toString();
      const stderr = (result.stderr || "").toString();
      throw new Error(`tsc failed (exit ${result.status})\n\nSTDOUT:\n${stdout}\n\nSTDERR:\n${stderr}`);
    }
  });
});
