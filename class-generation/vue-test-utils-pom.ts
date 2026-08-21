import { DOMWrapper, type VueWrapper } from "@vue/test-utils";

export type VueTestUtilsPomRoot = DOMWrapper<Element> | VueWrapper;

export interface VueTestUtilsPomOptions {
  testIdAttribute?: string;
}

/**
 * Behavior-oriented runtime for generated Vue Test Utils component objects.
 *
 * Generated objects scope every lookup to `wrapper`; consumers can use that wrapper
 * directly for assertions that do not warrant a generated behavior method.
 */
export class VueTestUtilsPom {
  public readonly wrapper: VueTestUtilsPomRoot;
  private readonly testIdAttribute: string;

  public constructor(wrapper: VueTestUtilsPomRoot, options: VueTestUtilsPomOptions = {}) {
    this.wrapper = wrapper;
    this.testIdAttribute = (options.testIdAttribute ?? "data-testid").trim() || "data-testid";
  }

  protected getByTestId(testId: string): DOMWrapper<Element> {
    return this.getInScope(this.wrapper, this.selectorFor(this.testIdAttribute, testId));
  }

  protected getByAnyTestId(testIds: readonly string[]): DOMWrapper<Element> {
    for (const testId of testIds) {
      const candidate = this.findInScope(this.wrapper, this.selectorFor(this.testIdAttribute, testId));
      if (candidate) {
        return candidate;
      }
    }

    throw new Error(`[vue-pom-generator] None of the generated test ids were found: ${testIds.join(", ")}`);
  }

  protected getComponentInstance(instanceId: string, within?: VueTestUtilsPomRoot): DOMWrapper<Element> {
    return this.getInScope(
      within ?? this.wrapper,
      this.selectorFor("data-pom-instance", instanceId),
    );
  }

  protected async clickByTestId(testId: string): Promise<void> {
    await this.getByTestId(testId).trigger("click");
  }

  protected async selectVSelectByTestId(testId: string, value: string): Promise<void> {
    await this.selectVSelect(this.getByTestId(testId), value);
  }

  protected async selectVSelectByAnyTestId(testIds: readonly string[], value: string): Promise<void> {
    await this.selectVSelect(this.getByAnyTestId(testIds), value);
  }

  private async selectVSelect(root: DOMWrapper<Element>, value: string): Promise<void> {
    const input = root.get<HTMLInputElement>("input");
    await input.trigger("click");
    await input.setValue(value);
    await root.get("ul.vs__dropdown-menu li[role='option']").trigger("click");
  }

  protected async clickWithinTestIdByLabel(
    rootTestId: string,
    labelText: string,
    exact: boolean = false,
  ): Promise<void> {
    const labels = this.getByTestId(rootTestId).findAll("label");
    const matchingLabels = labels.filter((label) => {
      const text = label.text().trim();
      return exact ? text === labelText : text.includes(labelText);
    });
    if (matchingLabels.length !== 1) {
      throw new Error(
        `[vue-pom-generator] Expected one label ${JSON.stringify(labelText)} within ${JSON.stringify(rootTestId)}, found ${matchingLabels.length}.`,
      );
    }

    const input = matchingLabels[0]!.find<HTMLInputElement>("input");
    if (input.exists()) {
      await input.setValue();
      return;
    }

    await matchingLabels[0]!.trigger("click");
  }

  private getInScope(root: VueTestUtilsPomRoot, selector: string): DOMWrapper<Element> {
    const candidate = this.findInScope(root, selector);
    if (candidate) {
      return candidate;
    }

    // Delegate the missing-element error to VTU so callers receive its DOM snapshot.
    return root.get<Element>(selector) as DOMWrapper<Element>;
  }

  private findInScope(root: VueTestUtilsPomRoot, selector: string): DOMWrapper<Element> | null {
    if (root.element instanceof Element && root.element.matches(selector)) {
      return new DOMWrapper(root.element);
    }

    const candidate = root.find<Element>(selector);
    return candidate.exists() ? candidate : null;
  }

  private selectorFor(attribute: string, value: string): string {
    return `[${attribute}=${JSON.stringify(value)}]`;
  }
}
