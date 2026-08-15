// @vitest-environment node
import type { TestCase, TestResult } from "@playwright/test/reporter";
import { describe, expect, it } from "vitest";

import type { PomFailureDiagnostics } from "../class-generation/diagnostics";
import { formatPomFailureReport } from "../playwright/reporter";

function fakeTestCase(): TestCase {
  return Object.assign({} as TestCase, {
    expectedStatus: "passed",
    location: { file: "/repo/tests/playwright/record.spec.ts", line: 42, column: 3 },
    parent: { project: () => ({ name: "chromium" }) },
    titlePath: () => ["record.spec.ts", "records", "creates a record"],
  });
}

function fakeResult(): TestResult {
  return Object.assign({} as TestResult, {
    attachments: [],
    errors: [{ message: "locator did not become visible", stack: "Error: locator did not become visible\n  at record.spec.ts:42:3" }],
    retry: 0,
    status: "failed",
  });
}

function diagnostics(): PomFailureDiagnostics {
  return {
    schemaVersion: 1,
    capturedAt: "2026-08-15T00:00:00.000Z",
    captureBudgetMs: 5_000,
    activeAction: {
      componentName: "RecordListPage",
      methodName: "goToCreateRecord",
      expectedTestIds: ["RecordListPage-Create-routerlink", "RecordListPage-New-routerlink"],
    },
    pages: [{
      url: "http://localhost/records",
      title: "Records",
      closed: false,
      ariaSnapshot: "- main:\n  - heading \"Records\"",
      renderedElements: [{
        testId: "RecordListPage-Create-routerlink",
        tag: "a",
        role: "link",
        name: "Create record",
        visible: true,
        enabled: true,
      }],
      component: {
        componentName: "RecordListPage",
        className: "RecordListPage",
        sourceFile: "/repo/src/views/RecordListPage.vue",
        matchedTestIds: 1,
        methods: [{
          methodName: "goToCreateRecord",
          kind: "action",
          signature: "goToCreateRecord()",
          expectedTestIds: ["RecordListPage-Create-routerlink", "RecordListPage-New-routerlink"],
          state: "present",
        }, {
          methodName: "clickDeleteRecord",
          kind: "action",
          signature: "clickDeleteRecord(recordId: string)",
          expectedTestIds: ["RecordListPage-${recordId}-Delete-button"],
          state: "absent",
        }],
      },
      routerNavigation: {
        id: 3,
        status: "pending",
        stage: "waiting-for-router-ready",
        targetName: "records",
      },
      screenshotPath: "/tmp/vue-pom-generator-failure.png",
      captureErrors: [],
    }],
    console: ["[error] example browser error"],
    pageErrors: [],
    networkFailures: ["500 GET http://localhost/api/records"],
    httpFailures: [{
      status: 500,
      method: "GET",
      url: "http://localhost/api/records",
      contentType: "application/problem+json",
      body: '{"title":"Database unavailable"}',
    }],
    pendingRequests: ["GET fetch http://localhost/api/v1/auth — pending 5001ms"],
    jsonPath: "/tmp/vue-pom-generator-failure.json",
  };
}

describe("Playwright failure reporter", () => {
  it("prints actionable generated-method context and an isolated rerun", () => {
    const report = formatPomFailureReport(fakeTestCase(), fakeResult(), diagnostics());

    expect(report).toContain("RecordListPage.goToCreateRecord");
    expect(report).toContain("[present] goToCreateRecord()");
    expect(report).toContain("[absent] clickDeleteRecord(recordId: string)");
    expect(report).toContain("Availability describes the current page state");
    expect(report).toContain("500 GET http://localhost/api/records");
    expect(report).toContain("pending at waiting-for-router-ready -> records");
    expect(report).toContain("GET fetch http://localhost/api/v1/auth — pending 5001ms");
    expect(report).toContain("--max-failures=1");
    expect(report).toContain("record.spec.ts:42");
    expect(report).toContain("/tmp/vue-pom-generator-failure.json");
    expect(report).toContain("HTTP error responses:");
    expect(report).toContain('{"title":"Database unavailable"}');
  });

  it("keeps the footer when the stdout report is truncated", () => {
    const report = formatPomFailureReport(fakeTestCase(), fakeResult(), diagnostics(), { maxOutputCharacters: 900 });

    expect(report.length).toBeLessThanOrEqual(900);
    expect(report).toContain("report truncated");
    expect(report).toContain("Structured diagnostics:");
    expect(report).toContain("--max-failures=1");
  });

  it("explains when no browser diagnostic attachment exists", () => {
    const report = formatPomFailureReport(fakeTestCase(), fakeResult(), null);

    expect(report).toContain("Browser diagnostics: unavailable");
    expect(report).toContain("Structured diagnostics: unavailable");
  });
});
