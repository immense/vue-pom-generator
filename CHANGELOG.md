# Changelog

## Unreleased

- **Consumer-visible change:** annotator source paths change from absolute checkout
  paths to repository-root-relative paths, preserving folders such as `frontend/`
  and `shared/ui/`. Hover labels, Preview, Copy, and annotation payloads no longer
  trim a hard-coded folder prefix. Consumers parsing or resolving `source` must use
  the repository root instead of a machine's checkout path.
- Add `runtime.annotator.sourceRoot` for an explicit root, resolved relative to the
  Vite root when not absolute. Without it, use the nearest ancestor containing a
  `.git` directory or worktree file; builds without `.git` must set the option.
- Stamp component usage locations separately as `<metadataAttributePrefix>-usage`
  (default `data-v-pom-usage`). Add optional `usageSource` to `FormattedAnnotation`
  and every `AnnotationReference`, including submit-hook payloads. Hover, Preview,
  and Copy show **Source** and **Used at**. Compiled components consume the usage
  prop so the nearest usage wins in nested component roots, while the element's
  own source remains intact. Descendants and fragment roots share their owning
  component's usage; slot content retains its authoring template's ownership.

## 1.0.125

- With `runtime.annotator.enabled`, stamp the source attribute on every native template
  element from its own location, not only on elements that get a test id. The value
  format is unchanged (`<file>:<line>:<column>`). Component usages are no longer
  stamped, so a parent's fallthrough attributes can't overwrite a child root's own
  location. A root rendered by a third-party component, such as a `RouterLink` `<a>`,
  no longer carries the usage-site location. Test-id generation is unchanged.
- While selecting, outline every element that has a source location (Settings →
  **Outline source elements**, on by default), and snap hover and click to the nearest
  such element, itself or an ancestor.
- Keep the settings panel open and in place when a setting changes.

- Suppress the annotator's **Submitted** toast when the submit handler returns or
  resolves `true`, allowing the app to show its own success UI. Accepted, unchanged
  annotations are still cleared. Returning `false` or `undefined`, throwing, or
  rejecting still keeps the queue and shows **Submit failed**. Without a handler,
  Submit remains hidden and the queue is kept.
