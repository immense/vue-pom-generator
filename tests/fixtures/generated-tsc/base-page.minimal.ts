/* eslint-disable */
export type Fluent<T extends object> = T & PromiseLike<T>;

export class BasePage {
  public page: any;

  public constructor(page?: any, _options?: { testIdAttribute?: string }) {
    this.page = page;
  }
}
