/* eslint-disable */
export type Fluent<T extends object> = T & PromiseLike<T>;

export class BasePage {
  public page: any;

  public constructor(page?: any, _options?: { root?: any; testIdAttribute?: string }) {
    this.page = page;
  }

  protected componentInstanceLocator(_instanceId: string, _within?: any): any {
    return null as any;
  }
}
