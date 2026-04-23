// Shared click-instrumentation contract between the Vue template transform and
// the generated Playwright Page Object Model runtime.

export const TESTID_CLICK_EVENT_NAME = "__testid_event__";

export interface TestIdClickEventDetail {
  testId?: string;
  phase?: "before" | "after" | "error" | string;
  err?: string;
}
