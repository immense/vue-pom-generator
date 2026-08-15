import { readFileSync } from "node:fs";
import path from "node:path";
import type {
  Reporter,
  TestCase,
  TestResult,
} from "@playwright/test/reporter";

import {
  POM_FAILURE_ATTACHMENT_NAME,
  type PomFailureDiagnostics,
  type PomPageFailureSnapshot,
} from "../class-generation/diagnostics";

const DEFAULT_MAX_OUTPUT_CHARACTERS = 32_000;
const DEFAULT_MAX_METHODS = 80;
const DEFAULT_MAX_ELEMENTS = 80;
const DEFAULT_MAX_EVENTS = 30;
const DEFAULT_MAX_ARIA_CHARACTERS = 8_000;

export interface PomFailureReporterOptions {
  maxOutputCharacters?: number;
}

function shellQuote(value: string): string {
  let quoted = "'";
  for (const character of value) {
    quoted += character === "'" ? `'"'"'` : character;
  }
  return `${quoted}'`;
}

function readDiagnostics(result: TestResult): PomFailureDiagnostics | null {
  const attachment = result.attachments.find(candidate => candidate.name === POM_FAILURE_ATTACHMENT_NAME);
  if (!attachment) return null;

  try {
    if (attachment.body) return JSON.parse(attachment.body.toString("utf8")) as PomFailureDiagnostics;
    if (attachment.path) return JSON.parse(readFileSync(attachment.path, "utf8")) as PomFailureDiagnostics;
  }
  catch {
    return null;
  }
  return null;
}

function appendLimited(lines: string[], heading: string, values: readonly string[], limit: number): void {
  if (!values.length) return;
  lines.push(heading);
  for (const value of values.slice(-limit)) lines.push(`  ${value}`);
  const omitted = Math.max(0, values.length - limit);
  if (omitted) lines.push(`  … ${omitted} earlier entries omitted`);
}

function formatPage(lines: string[], page: PomPageFailureSnapshot, index: number): void {
  lines.push(`Page ${index + 1}: ${page.url || "<no URL>"}`);
  if (page.title) lines.push(`Title: ${page.title}`);
  if (page.closed) lines.push("State: page was already closed");
  if (page.routerNavigation) {
    lines.push(
      `Generated router navigation: ${page.routerNavigation.status} at ${page.routerNavigation.stage} -> ${page.routerNavigation.targetName}`,
    );
    if (page.routerNavigation.error) lines.push(`Router error: ${page.routerNavigation.error}`);
  }

  if (page.component) {
    const available = page.component.methods.filter(method => method.state === "present").length;
    lines.push(
      `Generated POM match: ${page.component.className} (${page.component.matchedTestIds} rendered test ids; ${available}/${page.component.methods.length} methods currently present)`,
    );
    lines.push(`Vue source: ${page.component.sourceFile}`);
    for (const method of page.component.methods.slice(0, DEFAULT_MAX_METHODS)) {
      lines.push(`  [${method.state}] ${method.signature} <- ${method.expectedTestIds.join(" | ")}`);
    }
    const omittedMethods = Math.max(0, page.component.methods.length - DEFAULT_MAX_METHODS);
    if (omittedMethods) lines.push(`  … ${omittedMethods} generated methods omitted; see JSON`);
    lines.push("  Availability describes the current page state; an unavailable method is not inherently an error.");
  }
  else {
    lines.push("Generated POM match: no active page POM identified from rendered test ids");
  }

  if (page.renderedElements.length) {
    lines.push("Rendered generated elements:");
    for (const element of page.renderedElements.slice(0, DEFAULT_MAX_ELEMENTS)) {
      const state = `${element.visible ? "visible" : "hidden"}/${element.enabled ? "enabled" : "disabled"}`;
      const semantics = [element.role ? `role=${element.role}` : null, element.name ? `name=${JSON.stringify(element.name)}` : null]
        .filter(Boolean)
        .join(" ");
      lines.push(`  ${element.testId} <${element.tag}> ${state}${semantics ? ` ${semantics}` : ""}`);
    }
    const omittedElements = Math.max(0, page.renderedElements.length - DEFAULT_MAX_ELEMENTS);
    if (omittedElements) lines.push(`  … ${omittedElements} rendered elements omitted; see JSON`);
  }

  if (page.ariaSnapshot) {
    const aria = page.ariaSnapshot.slice(0, DEFAULT_MAX_ARIA_CHARACTERS);
    lines.push("Accessibility snapshot:", aria);
    if (aria.length < page.ariaSnapshot.length) {
      lines.push(`  … ${page.ariaSnapshot.length - aria.length} accessibility-snapshot characters omitted; see JSON`);
    }
  }
  else if (page.ariaSnapshotError) {
    lines.push(`Accessibility snapshot unavailable: ${page.ariaSnapshotError}`);
  }

  appendLimited(lines, "Capture warnings:", page.captureErrors, DEFAULT_MAX_EVENTS);
}

function formatErrors(result: TestResult): string[] {
  if (!result.errors.length) return ["Playwright error: failure did not include an Error object"];
  return result.errors.map((error, index) => {
    const value = error.stack ?? error.message ?? error.value ?? "Unknown error";
    return `Error ${index + 1}:\n${String(value).slice(0, 6_000)}`;
  });
}

function isolatedCommand(test: TestCase): string {
  const location = `${path.relative(process.cwd(), test.location.file)}:${test.location.line}`;
  return `npx playwright test ${shellQuote(location)} --project=${shellQuote(test.parent.project()?.name ?? "chromium")} --max-failures=1`;
}

function boundOutput(lines: string[], footer: string[], maximum: number): string {
  const full = [...lines, ...footer].join("\n");
  if (full.length <= maximum) return full;

  const footerText = footer.join("\n");
  const marker = `\n… report truncated by ${full.length - maximum} characters; use the JSON artifact for complete structured diagnostics …\n`;
  const available = Math.max(0, maximum - footerText.length - marker.length - 1);
  return `${lines.join("\n").slice(0, available)}${marker}${footerText}`;
}

export function formatPomFailureReport(
  test: TestCase,
  result: TestResult,
  diagnostics: PomFailureDiagnostics | null,
  options: PomFailureReporterOptions = {},
): string {
  const title = test.titlePath().join(" › ");
  const lines = [
    "================ VUE POM FAILURE DIAGNOSTICS ================",
    `Test: ${title}`,
    `Location: ${test.location.file}:${test.location.line}:${test.location.column}`,
    `Attempt: ${result.retry + 1}`,
    `Status: ${result.status} (expected ${test.expectedStatus})`,
    ...formatErrors(result),
  ];

  if (diagnostics) {
    if (diagnostics.activeAction) {
      lines.push(
        `Active generated action: ${diagnostics.activeAction.componentName ? `${diagnostics.activeAction.componentName}.` : ""}${diagnostics.activeAction.methodName}`,
      );
      if (diagnostics.activeAction.expectedTestIds.length) {
        lines.push(`Expected generated test ids: ${diagnostics.activeAction.expectedTestIds.join(" | ")}`);
      }
    }
    else {
      lines.push("Active generated action: none recorded");
    }
    diagnostics.pages.forEach((page, index) => formatPage(lines, page, index));
    appendLimited(lines, "Browser console:", diagnostics.console, DEFAULT_MAX_EVENTS);
    appendLimited(lines, "Page errors:", diagnostics.pageErrors, DEFAULT_MAX_EVENTS);
    appendLimited(lines, "Network failures:", diagnostics.networkFailures, DEFAULT_MAX_EVENTS);
    appendLimited(
      lines,
      "HTTP error responses:",
      (diagnostics.httpFailures ?? []).map((failure) => {
        const heading = `${failure.status} ${failure.method} ${failure.url}${failure.contentType ? ` (${failure.contentType})` : ""}`;
        if (failure.body) return `${heading}\nResponse body:\n${failure.body}`;
        if (failure.bodyCaptureError) return `${heading}\nResponse body unavailable: ${failure.bodyCaptureError}`;
        return heading;
      }),
      DEFAULT_MAX_EVENTS,
    );
    appendLimited(lines, "Requests still pending at failure:", diagnostics.pendingRequests ?? [], DEFAULT_MAX_EVENTS);
  }
  else {
    lines.push(
      "Browser diagnostics: unavailable. The test did not initialize generated POM fixtures, the page closed before capture, or capture itself failed.",
    );
  }

  const footer = [
    diagnostics ? `Structured diagnostics: ${diagnostics.jsonPath}` : "Structured diagnostics: unavailable",
    `Isolated rerun: ${isolatedCommand(test)}`,
    "=============================================================",
  ];
  return boundOutput(lines, footer, options.maxOutputCharacters ?? DEFAULT_MAX_OUTPUT_CHARACTERS);
}

export default class PomFailureReporter implements Reporter {
  private readonly options: PomFailureReporterOptions;

  public constructor(options: PomFailureReporterOptions = {}) {
    this.options = options;
  }

  public onTestEnd(test: TestCase, result: TestResult): void {
    if (result.status === test.expectedStatus || result.status === "skipped") return;
    const diagnostics = readDiagnostics(result);
    process.stdout.write(`${formatPomFailureReport(test, result, diagnostics, this.options)}\n`);
  }

  public printsToStdio(): boolean {
    return true;
  }
}
