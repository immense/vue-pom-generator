// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Buffer } from "node:buffer";
import type { BrowserContext, Page } from "playwright";
import { describe, expect, it } from "vitest";

import {
  installPomFailureDiagnostics,
  POM_FAILURE_ATTACHMENT_NAME,
  recordPomAction,
  type PomDiagnosticsTestInfo,
  type PomManifest,
} from "../class-generation/diagnostics";

describe("Playwright failure diagnostics", () => {
  it("captures live browser state, buffered errors, and parameterized method availability", async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "vue-pom-diagnostics-"));
    try {
      const pageListeners = new Map<string, (value: never) => void>();
      const contextListeners = new Map<string, (value: never) => void>();
      let page: Page;
      const context = Object.assign({} as BrowserContext, {
        pages: () => [page],
        on: (event: string, callback: (value: never) => void) => {
          contextListeners.set(event, callback);
          return context;
        },
      });
      page = Object.assign({} as Page, {
        context: () => context,
        evaluate: async () => ({
          title: "Records",
          elements: [{
            testId: "RecordListPage-42-Delete-button",
            tag: "button",
            role: "button",
            name: "Delete record",
            visible: true,
            enabled: true,
          }],
        }),
        isClosed: () => false,
        locator: () => ({ ariaSnapshot: async () => "- main:\n  - button \"Delete record\"" }),
        on: (event: string, callback: (value: never) => void) => {
          pageListeners.set(event, callback);
          return page;
        },
        screenshot: async ({ path: screenshotPath }: { path: string }) => {
          fs.writeFileSync(screenshotPath, "screenshot", "utf8");
          return Buffer.from("screenshot");
        },
        url: () => "http://localhost/records",
      });

      const attachments: Array<{ name: string; path?: string }> = [];
      const testInfo: PomDiagnosticsTestInfo = {
        outputPath: (...segments) => path.join(outputDir, ...segments),
        attach: async (name, options) => {
          attachments.push({ name, path: options?.path });
        },
      };
      const manifest: PomManifest = {
        RecordListPage: {
          componentName: "RecordListPage",
          className: "RecordListPage",
          sourceFile: "/repo/src/views/RecordListPage.vue",
          kind: "view",
          entries: [{
            testId: "RecordListPage-${recordId}-Delete-button",
            selectorPatternKind: "parameterized",
            generatedMethods: [{
              name: "clickDeleteRecord",
              kind: "action",
              parameters: [
                { name: "recordId", type: "string" },
                { name: "annotationText", typeExpression: "string = \"\"", type: "string", initializer: "\"\"" },
              ],
            }],
          }],
        },
      };

      const capture = installPomFailureDiagnostics(page, manifest, testInfo);
      recordPomAction(page, {
        componentName: "RecordListPage",
        methodName: "clickDeleteRecord",
        expectedTestIds: ["RecordListPage-42-Delete-button"],
      });
      pageListeners.get("console")?.({ type: () => "error", text: () => "browser failed" } as never);
      pageListeners.get("pageerror")?.(new Error("uncaught browser error") as never);
      pageListeners.get("request")?.({
        method: () => "GET",
        resourceType: () => "fetch",
        url: () => "http://localhost/api/records/pending",
      } as never);
      pageListeners.get("requestfailed")?.({
        failure: () => ({ errorText: "connection reset" }),
        method: () => "GET",
        url: () => "http://localhost/api/records",
      } as never);
      pageListeners.get("response")?.({
        headers: () => ({ "content-type": "application/problem+json" }),
        request: () => ({ method: () => "POST" }),
        status: () => 500,
        text: async () => JSON.stringify({ title: "Migration failed", detail: "Duplicate record" }),
        url: () => "http://localhost/api/records/migrate",
      } as never);

      const result = await capture.capture();

      expect(result.activeAction?.methodName).toBe("clickDeleteRecord");
      expect(result.pages[0]?.component?.className).toBe("RecordListPage");
      expect(result.pages[0]?.component?.methods[0]).toMatchObject({
        signature: "clickDeleteRecord(recordId: string, annotationText: string = \"\")",
        state: "present",
      });
      expect(result.console).toContain("[error] browser failed");
      expect(result.pageErrors).toContain("uncaught browser error");
      expect(result.networkFailures[0]).toContain("connection reset");
      expect(result.httpFailures?.[0]).toEqual({
        status: 500,
        method: "POST",
        url: "http://localhost/api/records/migrate",
        contentType: "application/problem+json",
        body: JSON.stringify({ title: "Migration failed", detail: "Duplicate record" }),
      });
      expect(result.pendingRequests?.[0]).toContain("GET fetch http://localhost/api/records/pending — pending");
      expect(fs.existsSync(result.jsonPath)).toBe(true);
      expect(attachments.some(attachment => attachment.name === POM_FAILURE_ATTACHMENT_NAME)).toBe(true);
    }
    finally {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });
});
