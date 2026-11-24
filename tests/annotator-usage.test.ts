// @vitest-environment jsdom
import { compile } from "@vue/compiler-dom";
import { mount } from "@vue/test-utils";
import * as Vue from "vue";
import { describe, expect, it } from "vitest";
import { createTestIdTransform } from "../transform";
import { __internal } from "../plugin/runtime/annotator/plugin";
import { resolveVueComponentInfo } from "../plugin/runtime/annotator/vue-detector";

function component(file: string, template: string, options: Vue.ComponentOptions = {}, prefix = "data-v-pom") {
  const { code } = compile(template, {
    filename: `/repo/${file}`,
    prefixIdentifiers: true,
    nodeTransforms: [createTestIdTransform("Example", new Map(), {}, ["Example"], "/repo/frontend/src/views", {
      annotatorMetadata: { sourceAttribute: "data-source", metadataAttributePrefix: prefix, getSourceRoot: () => "/repo" },
    })],
  });
  // eslint-disable-next-line no-new-func -- Execute compiler output to test real Vue rendering.
  const render = new Function("Vue", code)(Vue);
  const compiled = __internal.addComponentMetadata("const _sfc_main = component;\nexport default _sfc_main;", file, `${prefix}-usage`)!;
  // eslint-disable-next-line no-new-func -- Execute the compiled component metadata assignment.
  return new Function("component", `${compiled.replace("export default _sfc_main;", "")}\nreturn _sfc_main;`)({ ...options, render });
}

describe("component usage locations", () => {
  it.each(["data-v-pom", "data-custom"])("keeps the nearest nested usage and own source with %s", async (prefix) => {
    const Button = component("shared/ui/Button.vue", '<button v-bind="$attrs">{{ label }}</button>', { props: ["label"] }, prefix);
    const Wrapper = component("frontend/src/Wrapper.vue", '<Button v-bind="$attrs" :label="label" />', { components: { Button }, props: { label: String } }, prefix);
    const Page = component("frontend/src/views/Page.vue", '<Wrapper :label="label" />', { components: { Wrapper }, props: ["label"] }, prefix);
    const wrapper = mount(Page, { props: { label: "Save" } });
    const button = wrapper.get("button");
    const expected = {
      "data-source": "shared/ui/Button.vue:1:1",
      [`${prefix}-usage`]: "frontend/src/Wrapper.vue:1:1",
    };
    expect(button.attributes()).toMatchObject(expected);
    expect(resolveVueComponentInfo(button.element, { sourceAttribute: "data-source", metadataAttributePrefix: prefix })).toMatchObject({
      source: expected["data-source"], usageSource: expected[`${prefix}-usage`],
      formatted: "Button · Source: shared/ui/Button.vue:1:1 · Used at: frontend/src/Wrapper.vue:1:1",
    });
    await wrapper.setProps({ label: "Updated" });
    expect(button.text()).toBe("Updated");
    expect(button.attributes()).toMatchObject(expected);
    wrapper.unmount();
  });

  it("exposes the containing usage on descendants and fragment roots without forwarding $attrs", () => {
    const Card = component("shared/ui/Card.vue", '<section><span>Card</span></section><footer>Footer</footer>', { inheritAttrs: false });
    const Page = component("frontend/src/views/Page.vue", '<Card />', { components: { Card } });
    const wrapper = mount(Page);
    for (const element of wrapper.findAll("section, span, footer")) {
      expect(element.attributes("data-v-pom-usage")).toBe("frontend/src/views/Page.vue:1:1");
      expect(element.attributes("data-source")).toContain("shared/ui/Card.vue:");
    }
    wrapper.unmount();
  });

  it("does not treat built-in template controls as component usage sites", () => {
    const Card = component("shared/ui/Card.vue", "<Transition><section>Card</section></Transition>");
    const Page = component("frontend/src/views/Page.vue", "<Card />", { components: { Card } });
    const wrapper = mount(Page, { global: { stubs: { transition: false } } });
    expect(wrapper.get("section").attributes("data-v-pom-usage")).toBe("frontend/src/views/Page.vue:1:1");
    wrapper.unmount();
  });

  it("leaves usage absent for the app root and preserves slotted content ownership", () => {
    const Card = component("shared/ui/Card.vue", "<section><slot /></section>");
    const Page = component("frontend/src/views/Page.vue", '<main><Card><span>Slot</span></Card></main>', { components: { Card } });
    const wrapper = mount(Page);
    expect(wrapper.get("main").attributes("data-v-pom-usage")).toBeUndefined();
    expect(wrapper.get("section").attributes("data-v-pom-usage")).toBe("frontend/src/views/Page.vue:1:7");
    expect(wrapper.get("span").attributes("data-v-pom-usage")).toBeUndefined();
    expect(wrapper.get("span").attributes("data-source")).toBe("frontend/src/views/Page.vue:1:13");
    wrapper.unmount();
  });
});
