// Display-text helpers for the annotator runtime. These normalize text
// captured from the DOM (collapsing whitespace, trimming) for readable UI
// labels — not source code — so whitespace regexes are the appropriate tool.

/**
 * Normalize a UI display string: collapse whitespace runs to single spaces,
 * trim the ends, and return `undefined` for blank input.
 *
 * Returns `undefined` when `value` is itself `undefined` or collapses to empty,
 * so callers can use a simple truthiness check to decide whether to render a
 * line. This is display-text normalization, not source-code parsing.
 *
 * @example
 * normalizeInlineText("  foo\n  bar ") // "foo bar"
 * normalizeInlineText("   ") // undefined
 * normalizeInlineText(undefined) // undefined
 */
export function normalizeInlineText(value: string | undefined): string | undefined {
  /* eslint-disable no-restricted-syntax -- collapsing whitespace runs in display text, not parsing source code */
  const normalized = value?.replace(/\s+/g, " ").trim();
  /* eslint-enable no-restricted-syntax */
  return normalized || undefined;
}
