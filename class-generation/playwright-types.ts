export interface PwLocator {
  locator: (selector: string) => PwLocator;
  first: () => PwLocator;
  count: () => Promise<number>;
  click: (options?: { force?: boolean }) => Promise<void>;
  fill: (value: string, options?: { force?: boolean; timeout?: number }) => Promise<void>;
  getAttribute: (name: string) => Promise<string | null>;
  scrollIntoViewIfNeeded: (options?: { timeout?: number }) => Promise<void>;
}

export type PwSelectOption = string | { value?: string; label?: string; index?: number };

export interface PwPage {
  locator: (selector: string) => PwLocator;
  url: () => string;
  waitForTimeout: (timeout: number) => Promise<void>;
  evaluate: <R, Arg>(pageFunction: (arg: Arg) => R | Promise<R>, arg: Arg) => Promise<R>;
  isVisible: (selector: string, options?: { timeout?: number }) => Promise<boolean>;
  textContent: (selector: string, options?: { timeout?: number }) => Promise<string | null>;
  waitForSelector: (selector: string, options?: { timeout?: number }) => Promise<object | null>;
  hover: (selector: string, options?: { timeout?: number }) => Promise<void>;
  selectOption: (selector: string, values: PwSelectOption | PwSelectOption[], options?: { timeout?: number }) => Promise<string[]>;
}