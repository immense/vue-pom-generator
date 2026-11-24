import { normalizeInlineText } from "./text-utils";

export type OutputDetail = "standard" | "forensic";

export interface FormattedAnnotation {
  /** Stable runtime id of the queued annotation; same id on retries, changed content keeps the id. */
  id?: string;
  comment: string;
  targetLabel: string;
  source?: string;
  /** Template location that instantiates the component owning the element. */
  usageSource?: string;
  component?: string;
  uiText?: string;
  locator?: string;
  domHint?: string;
  /** Page URL where the annotation was captured (recorded at creation time, survives SPA route changes). */
  pageUrl?: string;
  /** Inline element pills, in comment order. Absent on records created before reference support. */
  references?: AnnotationReference[];
}

export interface AnnotationReference extends Pick<FormattedAnnotation, "targetLabel" | "source" | "usageSource" | "component" | "uiText" | "locator" | "domHint" | "pageUrl"> {
  /** Stable within this note, e.g. "element1". Removing a pill does not renumber the others. */
  id: string;
}

export function referenceText(reference: AnnotationReference): string {
  return `[${reference.id}: ${normalizeInlineText(reference.targetLabel)}]`;
}

/** Element identity, independent of display text, component visibility, and page URL. */
export function targetIdentityMatches(a: Omit<AnnotationReference, "id">, b: Omit<AnnotationReference, "id">): boolean {
  return a.targetLabel === b.targetLabel
    && a.source === b.source
    && a.usageSource === b.usageSource
    && a.locator === b.locator
    && a.domHint === b.domHint;
}

function formatTarget(target: Pick<FormattedAnnotation, "targetLabel" | "source" | "usageSource" | "component" | "uiText" | "locator" | "domHint">, detail: OutputDetail): string[] {
  const lines = [`- **Source:** ${target.source || "Unable to find component file path."}`];
  if (target.usageSource) {
    lines.push(`- **Used at:** ${target.usageSource}`);
  }
  if (target.component) {
    lines.push(`- **Component:** ${target.component}`);
  }
  lines.push(`- **Target:** \`${target.targetLabel}\``);
  const uiText = normalizeInlineText(target.uiText);
  if (uiText) {
    lines.push(`- **UI text:** \`${uiText}\``);
  }
  const locator = normalizeInlineText(target.locator);
  if (locator) {
    lines.push(`- **Locator:** ${locator}`);
  }
  if (detail === "forensic") {
    const domHint = normalizeInlineText(target.domHint);
    if (domHint) {
      lines.push(`- **DOM hint:** \`${domHint}\``);
    }
  }
  return lines;
}

export function formatAnnotations(
  annotations: FormattedAnnotation[],
  detail: OutputDetail,
  pageUrl: string,
): string {
  /* eslint-disable no-restricted-syntax -- stripping a URL scheme prefix from a display string, not parsing source code */
  const shortUrl = pageUrl.replace(/^https?:\/\//, "");
  /* eslint-enable no-restricted-syntax */
  const lines: string[] = [];

  lines.push(`## Feedback — ${shortUrl}`);
  lines.push(`- **URL:** ${pageUrl}`);
  if (detail === "forensic" && typeof window !== "undefined") {
    lines.push(`- **Viewport:** ${window.innerWidth}x${window.innerHeight}`);
  }
  lines.push("");

  for (let i = 0; i < annotations.length; i += 1) {
    const annotation = annotations[i]!;
    const title = normalizeInlineText(annotation.comment) || annotation.targetLabel;
    lines.push(`### ${i + 1}. ${title}`);
    const targetHasReference = annotation.references?.some(reference => targetIdentityMatches(annotation, reference));
    if (!targetHasReference) {
      lines.push(...formatTarget(annotation, detail));
    }
    if (annotation.pageUrl && annotation.pageUrl !== pageUrl) {
      lines.push(`- **URL:** ${annotation.pageUrl}`);
    }
    for (const reference of annotation.references ?? []) {
      lines.push("", `#### ${referenceText(reference)}`, ...formatTarget(reference, detail));
      if (reference.pageUrl && reference.pageUrl !== annotation.pageUrl && reference.pageUrl !== pageUrl) {
        lines.push(`- **URL:** ${reference.pageUrl}`);
      }
    }

    lines.push("");
  }

  return lines.join("\n");
}

export function formatSingleAnnotationPreview(
  annotation: FormattedAnnotation,
  detail: OutputDetail,
  pageUrl: string,
): string {
  const formatted = formatAnnotations([annotation], detail, pageUrl);
  const headingIndex = formatted.indexOf("### 1.");
  // reason: `formatAnnotations` is always called with a single-element array, so it
  // always emits a `### 1.` heading; the false branch of this ternary is unreachable.
  /* c8 ignore next */
  return headingIndex >= 0 ? formatted.slice(headingIndex).trim() : formatted.trim();
}
