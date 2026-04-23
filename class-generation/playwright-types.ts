import type { Locator as PwLocator, Page as PwPage } from "playwright";

export type { PwLocator, PwPage };

export type PwSelectOption = string | { value?: string; label?: string; index?: number };
