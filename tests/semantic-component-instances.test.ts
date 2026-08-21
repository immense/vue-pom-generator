// @vitest-environment jsdom
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

import { compile } from "@vue/compiler-dom";
import { parse as parseSfc } from "@vue/compiler-sfc";
import { mount } from "@vue/test-utils";
import { defineComponent, h, reactive } from "vue";
import { afterEach, describe, expect, it } from "vitest";

import { generateFiles } from "../class-generation";
import { createTestIdTransform } from "../transform";
import type { IComponentDependencies } from "../utils";
import { resetWrapperContractCaches } from "../wrapper-contract";

function typecheckGeneratedVueTestUtilsFiles(projectRoot: string, outputDir: string) {
  const require = createRequire(import.meta.url);
  const tscPath = require.resolve("typescript/bin/tsc");
  fs.symlinkSync(
    path.resolve("node_modules"),
    path.join(projectRoot, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const files = fs.readdirSync(outputDir)
    .filter(file => file.endsWith(".ts"))
    .map(file => path.join(outputDir, file));
  files.push(path.join(outputDir, "_pom-runtime", "vue-test-utils-pom.ts"));

  return spawnSync(process.execPath, [
    tscPath,
    "--noEmit",
    "--pretty",
    "false",
    "--target",
    "ES2022",
    "--module",
    "ESNext",
    "--moduleResolution",
    "Bundler",
    "--lib",
    "ES2022,DOM",
    "--skipLibCheck",
    "true",
    "--verbatimModuleSyntax",
    "true",
    ...files,
  ], {
    cwd: projectRoot,
    encoding: "utf8",
  });
}

describe("semantic component instances", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    resetWrapperContractCaches();
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("generates a keyed, slot-projected, semantically named component chain", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vue-pom-semantic-instances-"));
    temporaryDirectories.push(projectRoot);
    const componentsDir = path.join(projectRoot, "src", "components");
    const viewsDir = path.join(projectRoot, "src", "views");
    fs.mkdirSync(componentsDir, { recursive: true });
    fs.mkdirSync(viewsDir, { recursive: true });

    const sources = new Map<string, { filePath: string; source: string }>([
      ["DeploymentParametersForm", {
        filePath: path.join(viewsDir, "DeploymentParametersForm.vue"),
        source: `
          <template>
            <BaseDynamicForm :parameters="parameters">
              <template #parameterNameLine="{ parameter }">
                <OnboardingOption :model-value="parameter.onboardingOption" />
              </template>
            </BaseDynamicForm>
            <ClipboardDialog title="RDP Password">
              <CopyToClipboardInput :model-value="state.rdpPassword" />
            </ClipboardDialog>
          </template>
        `,
      }],
      ["BaseDynamicForm", {
        filePath: path.join(componentsDir, "BaseDynamicForm.vue"),
        source: `
          <template>
            <div>
              <DynamicFormField
                v-for="parameter in parameters"
                :key="parameter.name"
                :parameter="parameter"
                :model-value="parameter.value"
              >
                <template #parameterNameLine="{ parameter }">
                  <slot name="parameterNameLine" :parameter="parameter" />
                </template>
              </DynamicFormField>
            </div>
          </template>
        `,
      }],
      ["DynamicFormField", {
        filePath: path.join(componentsDir, "DynamicFormField.vue"),
        source: `
          <template>
            <div>
              <slot name="parameterNameLine" :parameter="parameter" />
              <input v-model="parameter.value" />
            </div>
          </template>
        `,
      }],
      ["OnboardingOption", {
        filePath: path.join(componentsDir, "OnboardingOption.vue"),
        source: `
          <template>
            <div>
              <ImmyRadioGroup
                :model-value="modelValue"
                :options="overridePolicyOptions"
              />
            </div>
          </template>
        `,
      }],
      ["ImmyRadioGroup", {
        filePath: path.join(componentsDir, "ImmyRadioGroup.vue"),
        source: `
          <template>
            <div role="radiogroup">
              <label v-for="option in options" :key="option.value">
                <input
                  type="radio"
                  :value="option.value"
                  :checked="modelValue === option.value"
                  @change="$emit('update:modelValue', option.value)"
                />
                <span>{{ option.label }}</span>
              </label>
            </div>
          </template>
        `,
      }],
      ["ClipboardDialog", {
        filePath: path.join(componentsDir, "ClipboardDialog.vue"),
        source: `
          <template>
            <section>
              <button aria-label="Close">Close</button>
              <slot />
            </section>
          </template>
        `,
      }],
      ["CopyToClipboardInput", {
        filePath: path.join(componentsDir, "CopyToClipboardInput.vue"),
        source: `
          <template>
            <input aria-label="Copy value" :value="modelValue" />
          </template>
        `,
      }],
    ]);

    const componentHierarchyMap = new Map<string, IComponentDependencies>();
    const compiledTemplateByComponent = new Map<string, string>();
    const vueFilesPathMap = new Map(
      Array.from(sources, ([componentName, value]) => [componentName, value.filePath]),
    );

    for (const [, { filePath, source }] of sources) {
      fs.writeFileSync(filePath, source);
    }

    for (const [componentName, { filePath, source }] of sources) {
      const template = parseSfc(source, { filename: filePath }).descriptor.template?.content ?? "";
      const compiled = compile(template, {
        filename: filePath,
        expressionPlugins: ["typescript"],
        nodeTransforms: [
          createTestIdTransform(componentName, componentHierarchyMap, {}, [], viewsDir, {
            existingIdBehavior: "error",
            vueFilesPathMap,
            wrapperSearchRoots: [componentsDir, viewsDir],
            optionKeyAttribute: { ImmyRadioGroup: "value" },
          }),
        ],
      });
      compiledTemplateByComponent.set(componentName, compiled.code);
    }

    const outDir = path.join(projectRoot, "generated");
    const vueTestUtilsOutDir = path.join(projectRoot, "generated-vtu");
    await generateFiles(
      componentHierarchyMap,
      vueFilesPathMap,
      path.resolve("class-generation", "base-page.ts"),
      {
        outDir,
        projectRoot,
        typescriptOutputStructure: "split",
        vueTestUtilsOutDir,
      },
    );

    const formPom = fs.readFileSync(path.join(outDir, "DeploymentParametersForm.g.ts"), "utf8");
    const onboardingPom = fs.readFileSync(path.join(outDir, "OnboardingOption.g.ts"), "utf8");
    const radioPom = fs.readFileSync(path.join(outDir, "ImmyRadioGroup.g.ts"), "utf8");
    const formVtuPom = fs.readFileSync(path.join(vueTestUtilsOutDir, "DeploymentParametersForm.vtu.g.ts"), "utf8");
    const onboardingVtuPom = fs.readFileSync(path.join(vueTestUtilsOutDir, "OnboardingOption.vtu.g.ts"), "utf8");
    const radioVtuPom = fs.readFileSync(path.join(vueTestUtilsOutDir, "ImmyRadioGroup.vtu.g.ts"), "utf8");

    expect(formPom).toContain("DynamicFormField(key: string): DynamicFormField & { readonly OnboardingOption: OnboardingOption }");
    expect(formPom).toContain("const ownerRoot = this.componentInstanceLocator(\"DeploymentParametersForm-BaseDynamicForm-component\")");
    expect(formPom).toContain("const root = this.componentInstanceLocator(`BaseDynamicForm-${key}-DynamicFormField-component`, ownerRoot)");
    expect(formPom).toContain("OnboardingOption: new OnboardingOption(this.page, this.componentInstanceLocator(\"DeploymentParametersForm-OnboardingOption-component\", root))");
    expect(compiledTemplateByComponent.get("DeploymentParametersForm"))
      .toContain("DeploymentParametersForm-RdpPassword-component");
    expect(compiledTemplateByComponent.get("DeploymentParametersForm"))
      .toContain("DeploymentParametersForm-CopyToClipboardInput-component");

    expect(onboardingPom).toContain("OverridePolicyOptions: ImmyRadioGroup");
    expect(onboardingPom).toContain("this.OverridePolicyOptions = new ImmyRadioGroup(page, this.componentInstanceLocator(\"OnboardingOption-OverridePolicyOptions-component\"))");

    expect(radioPom).toContain("async selectByValue(value: string, annotationText: string = \"\")");
    expect(radioPom).toContain("`ImmyRadioGroup-${value}-OptionValue-radio`");

    expect(formVtuPom).toContain("DynamicFormField(key: string): DynamicFormField & { readonly OnboardingOption: OnboardingOption }");
    expect(formVtuPom).toContain("const ownerRoot = this.getComponentInstance(\"DeploymentParametersForm-BaseDynamicForm-component\")");
    expect(formVtuPom).toContain("const root = this.getComponentInstance(`BaseDynamicForm-${key}-DynamicFormField-component`, ownerRoot)");
    expect(formVtuPom).toContain("OnboardingOption: new OnboardingOption(this.getComponentInstance(\"DeploymentParametersForm-OnboardingOption-component\", root))");
    expect(onboardingVtuPom).toContain("get OverridePolicyOptions(): ImmyRadioGroup");
    expect(onboardingVtuPom).toContain("return new ImmyRadioGroup(this.getComponentInstance(\"OnboardingOption-OverridePolicyOptions-component\"))");
    expect(onboardingVtuPom).not.toContain("this.OverridePolicyOptions =");
    expect(radioVtuPom).toContain("async selectByValue(value: string)");
    expect(radioVtuPom).toContain("await this.getByTestId(`ImmyRadioGroup-${value}-OptionValue-radio`).setValue()");
    expect(radioVtuPom).not.toContain("annotationText");
    expect(fs.readFileSync(path.join(vueTestUtilsOutDir, "index.ts"), "utf8"))
      .toContain("export * from \"./DeploymentParametersForm.vtu.g\"");

    const typecheck = typecheckGeneratedVueTestUtilsFiles(projectRoot, vueTestUtilsOutDir);
    expect(typecheck.status, `${typecheck.stdout}\n${typecheck.stderr}`).toBe(0);

    const runtimeBundlePath = path.join(projectRoot, "generated-vtu.cjs");
    const require = createRequire(import.meta.url);
    const bundle = spawnSync(require.resolve("esbuild/bin/esbuild"), [
      path.join(vueTestUtilsOutDir, "index.ts"),
      "--bundle",
      "--format=cjs",
      "--platform=node",
      "--target=node20",
      "--external:@vue/test-utils",
      `--outfile=${runtimeBundlePath}`,
    ], { encoding: "utf8" });
    expect(bundle.status, `${bundle.stdout}\n${bundle.stderr}`).toBe(0);
    const generated = require(runtimeBundlePath);
    const wrapper = mount(defineComponent({
      setup() {
        const selected = reactive({ server: "Allow" });
        return () => h("form", [
          h("div", { "data-pom-instance": "DeploymentParametersForm-BaseDynamicForm-component" }, [
            h("section", { "data-pom-instance": "BaseDynamicForm-server-DynamicFormField-component" }, [
              h("div", { "data-pom-instance": "DeploymentParametersForm-OnboardingOption-component" }, [
                h("div", { "data-pom-instance": "OnboardingOption-OverridePolicyOptions-component" }, [
                  ...["Allow", "Require"].map(value => h("input", {
                    type: "radio",
                    value,
                    checked: selected.server === value,
                    "data-testid": `ImmyRadioGroup-${value}-OptionValue-radio`,
                    onChange: () => selected.server = value,
                  })),
                ]),
              ]),
            ]),
          ]),
          h("output", { "data-testid": "selected-server" }, selected.server),
        ]);
      },
    }));
    const form = new generated.DeploymentParametersForm(wrapper);

    await form
      .DynamicFormField("server")
      .OnboardingOption
      .OverridePolicyOptions
      .selectByValue("Require");

    expect(wrapper.get('[data-testid="selected-server"]').text()).toBe("Require");
  });
});
