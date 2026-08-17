/* eslint-disable */
export type Fluent<T extends object> = T & PromiseLike<T>;

export class BasePage {
  public page: any;

  public constructor(page?: any, _options?: { testIdAttribute?: string }) {
    this.page = page;
  }

  protected fluent<T extends object>(_factory: () => Promise<T>): Fluent<T> {
    throw new Error("not implemented");
  }

  protected describeLocator<T>(_locator: T, _description?: string): T {
    return _locator;
  }

  protected locatorByTestId(_testId: string, _description?: string): any {
    return null as any;
  }

  protected keyedLocators<TKey extends string>(_getLocator: (key: TKey) => any): Record<TKey, any> {
    return {} as any;
  }

  protected selectorForTestId(testId: string): string {
    return `[data-testid="${testId}"]`;
  }

  protected async clickByTestId(_testId: string, _annotationText: string = "", _wait: boolean = true, _description?: string, _action?: { componentName?: string; methodName: string; preferAssociatedLabel?: boolean }): Promise<void> {}

  protected async clickLocator(_locator: any, _annotationText: string = "", _wait: boolean = true): Promise<void> {}

  protected async clickWithinTestIdByLabel(_rootTestId: string, _label: string, _annotationText: string = "", _wait: boolean = true, _options?: { exact?: boolean; description?: string; componentName?: string; methodName?: string }): Promise<void> {}

  protected async fillInputByTestId(_testId: string, _text: string, _annotationText: string = "", _description?: string, _action?: { componentName?: string; methodName: string }): Promise<void> {}

  protected async selectVSelectByTestId(_testId: string, _value: string, _annotationText: string = "", _description?: string, _action?: { componentName?: string; methodName: string }): Promise<void> {}

  protected recordPomAction(_componentName: string | undefined, _methodName: string, _expectedTestIds: readonly string[]): void {}

  protected async animateCursorToElement(_selector: string, _executeClick = true, _delay = 100, _annotationText: string = "", _waitForInstrumentationEvent = true): Promise<void> {}
}
