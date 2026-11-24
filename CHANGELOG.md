# Changelog

## Unreleased

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
