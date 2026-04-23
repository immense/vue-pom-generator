import type { ElementMetadata } from "./metadata-collector";
import { normalizePomRoleLabel } from "./pom-discoverability";

export interface AccessibilityAuditResult {
  needsReview: boolean;
  accessibleNameSource: "aria-label" | "title" | "text" | "dynamic" | "unknown" | "missing";
  reasons: string[];
  staticAriaLabel?: string;
  staticRole?: string;
  staticTitle?: string;
  staticTextContent?: string;
}

function supportsInlineTextAccessibleName(role: string): boolean {
  return role === "button" || role === "radio";
}

export function buildAccessibilityAudit(
  metadata: ElementMetadata | undefined,
  inferredRole: string | null,
): AccessibilityAuditResult | undefined {
  if (!metadata || !inferredRole) {
    return undefined;
  }

  const role = normalizePomRoleLabel(inferredRole).toLowerCase();
  const dynamicProps = new Set(metadata.dynamicProps ?? []);
  const hasDynamicAccessibleNameSignal = dynamicProps.has("aria-label")
    || dynamicProps.has("title")
    || !!metadata.hasDynamicText;

  let accessibleNameSource: AccessibilityAuditResult["accessibleNameSource"];
  const reasons: string[] = [];

  if (metadata.staticAriaLabel) {
    accessibleNameSource = "aria-label";
  }
  else if (supportsInlineTextAccessibleName(role) && metadata.staticTextContent) {
    accessibleNameSource = "text";
  }
  else if (metadata.staticTitle) {
    accessibleNameSource = "title";
  }
  else if (hasDynamicAccessibleNameSignal) {
    accessibleNameSource = "dynamic";
  }
  else if (role === "input" || role === "select") {
    accessibleNameSource = "unknown";
    reasons.push("No inline accessible-name signal was found; the element may rely on external markup such as a separate <label>.");
  }
  else {
    accessibleNameSource = "missing";
    reasons.push("No compile-time accessible-name signal was found.");
  }

  return {
    needsReview: accessibleNameSource === "unknown" || accessibleNameSource === "missing",
    accessibleNameSource,
    reasons,
    ...(metadata.staticAriaLabel ? { staticAriaLabel: metadata.staticAriaLabel } : {}),
    ...(metadata.staticRole ? { staticRole: metadata.staticRole } : {}),
    ...(metadata.staticTitle ? { staticTitle: metadata.staticTitle } : {}),
    ...(metadata.staticTextContent ? { staticTextContent: metadata.staticTextContent } : {}),
  };
}

export function collectAccessibilityReviewWarnings(
  manifest: Record<string, { entries: Array<{
    testId: string;
    generatedPropertyName: string | null;
    inferredRole: string | null;
    accessibility?: AccessibilityAuditResult;
  }> }>,
): string[] {
  const warnings: string[] = [];

  for (const [componentName, component] of Object.entries(manifest)) {
    for (const entry of component.entries) {
      if (!entry.accessibility?.needsReview) {
        continue;
      }

      const entryLabel = entry.generatedPropertyName ?? entry.testId;
      const reasonText = entry.accessibility.reasons.join(" ");
      warnings.push(
        `[vue-pom-generator] Accessibility review suggested for ${componentName}.${entryLabel}`
        + ` (role=${entry.inferredRole ?? "unknown"}, testId=${JSON.stringify(entry.testId)}): ${reasonText}`,
      );
    }
  }

  return warnings;
}
