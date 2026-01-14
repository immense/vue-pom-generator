// Shared click-instrumentation contract between the Vue template transform and
// the generated Playwright Page Object Model runtime.

export const TESTID_CLICK_EVENT_NAME = "__testid_event__";

// When strict mode is enabled, the injected click wrapper will fail fast if it
// cannot emit the expected event.
export const TESTID_CLICK_EVENT_STRICT_FLAG = "__testid_click_event_strict__";

export interface TestIdClickEventDetail {
  testId?: string;
  phase?: "before" | "after" | "error" | string;
  err?: string;
}
