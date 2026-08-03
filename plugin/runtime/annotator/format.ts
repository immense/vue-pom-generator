export type OutputDetail = "standard" | "forensic";

export interface FormattedAnnotation {
  comment: string;
  targetLabel: string;
  source?: string;
  component?: string;
  uiText?: string;
  locator?: string;
  domHint?: string;
}

function normalizeInlineText(value: string | undefined): string | undefined {
  /* eslint-disable no-restricted-syntax -- collapsing whitespace in UI display text, not parsing source code */
  const normalized = value?.replace(/\s+/g, " ").trim();
  /* eslint-enable no-restricted-syntax */
  return normalized || undefined;
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
    lines.push(`- **Source:** ${annotation.source || "Unable to find component file path."}`);

    if (annotation.component) {
      lines.push(`- **Component:** ${annotation.component}`);
    }

    lines.push(`- **Target:** \`${annotation.targetLabel}\``);

    const uiText = normalizeInlineText(annotation.uiText);
    if (uiText) {
      lines.push(`- **UI text:** \`${uiText}\``);
    }

    const locator = normalizeInlineText(annotation.locator);
    if (locator) {
      lines.push(`- **Locator:** ${locator}`);
    }

    if (detail === "forensic") {
      const domHint = normalizeInlineText(annotation.domHint);
      if (domHint) {
        lines.push(`- **DOM hint:** \`${domHint}\``);
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
  return headingIndex >= 0 ? formatted.slice(headingIndex).trim() : formatted.trim();
}
