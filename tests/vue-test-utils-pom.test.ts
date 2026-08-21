// @vitest-environment jsdom
import { mount } from "@vue/test-utils";
import { defineComponent, h, reactive } from "vue";
import { describe, expect, it } from "vitest";

import { VueTestUtilsPom, type VueTestUtilsPomRoot } from "../class-generation/vue-test-utils-pom";

class ImmyRadioGroup extends VueTestUtilsPom {
  public async selectByValue(value: string): Promise<void> {
    await this.getByTestId(`ImmyRadioGroup-${value}-OptionValue-radio`).setValue();
  }
}

class OnboardingOption extends VueTestUtilsPom {
  public readonly OverridePolicyOptions: ImmyRadioGroup;

  public constructor(wrapper: VueTestUtilsPomRoot) {
    super(wrapper);
    this.OverridePolicyOptions = new ImmyRadioGroup(
      this.getComponentInstance("OnboardingOption-OverridePolicyOptions-component"),
    );
  }
}

class DynamicFormField extends VueTestUtilsPom {}

class DeploymentParametersForm extends VueTestUtilsPom {
  public DynamicFormField(key: string): DynamicFormField & { readonly OnboardingOption: OnboardingOption } {
    const root = this.getComponentInstance(`BaseDynamicForm-${key}-DynamicFormField-component`);
    const instance = new DynamicFormField(root);
    return Object.assign(instance, {
      OnboardingOption: new OnboardingOption(
        this.getComponentInstance("DeploymentParametersForm-OnboardingOption-component", root),
      ),
    });
  }
}

class SearchableSelect extends VueTestUtilsPom {
  public async selectOwner(value: string): Promise<void> {
    await this.selectVSelectByTestId("Owner-vselect", value);
  }
}

const Harness = defineComponent({
  setup() {
    const values = reactive<Record<string, string>>({
      server: "Allow",
      workstation: "Allow",
    });

    return () => h("form", ["server", "workstation"].map(key => h("section", {
      "data-pom-instance": `BaseDynamicForm-${key}-DynamicFormField-component`,
    }, [
      h("div", { "data-pom-instance": "DeploymentParametersForm-OnboardingOption-component" }, [
        h("div", { "data-pom-instance": "OnboardingOption-OverridePolicyOptions-component" }, [
          ...["Allow", "Require"].map(value => h("input", {
            type: "radio",
            value,
            checked: values[key] === value,
            "data-testid": `ImmyRadioGroup-${value}-OptionValue-radio`,
            onChange: () => values[key] = value,
          })),
        ]),
      ]),
      h("output", { "data-testid": `selected-${key}` }, values[key]),
    ])));
  },
});

const SearchableSelectHarness = defineComponent({
  setup() {
    const state = reactive({ open: false, selected: "" });
    return () => h("div", { "data-testid": "Owner-vselect" }, [
      h("input", {
        onClick: () => state.open = true,
      }),
      state.open
        ? h("ul", { class: "vs__dropdown-menu" }, [
            h("li", {
              role: "option",
              onClick: () => state.selected = "Taylor",
            }, "Taylor"),
          ])
        : null,
      h("output", { "data-testid": "selected-owner" }, state.selected),
    ]);
  },
});

describe("VueTestUtilsPom", () => {
  it("drives a semantically named action within the selected component instance", async () => {
    const wrapper = mount(Harness);
    const form = new DeploymentParametersForm(wrapper);

    await form
      .DynamicFormField("server")
      .OnboardingOption
      .OverridePolicyOptions
      .selectByValue("Require");

    expect(wrapper.get('[data-testid="selected-server"]').text()).toBe("Require");
    expect(wrapper.get('[data-testid="selected-workstation"]').text()).toBe("Allow");
  });

  it("drives a searchable select through its rendered input and option", async () => {
    const wrapper = mount(SearchableSelectHarness);
    const select = new SearchableSelect(wrapper);

    await select.selectOwner("Taylor");

    expect(wrapper.get('[data-testid="selected-owner"]').text()).toBe("Taylor");
  });
});
