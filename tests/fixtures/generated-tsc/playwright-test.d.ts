/* eslint-disable */
export type Page = any;
export type Locator = any;
export type PlaywrightTestArgs = { page: Page };
export type TestType<TestArgs = any, WorkerArgs = any> = {
  extend<T>(_fixtures: any): TestType<TestArgs & T, WorkerArgs>;
};
export const test: TestType<PlaywrightTestArgs, {}>;
export const expect: any;
