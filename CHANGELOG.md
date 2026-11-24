# Changelog

## Unreleased

- Suppress the annotator's **Submitted** toast when the submit handler returns or
  resolves `true`, allowing the app to show its own success UI. Accepted, unchanged
  annotations are still cleared. Returning `false` or `undefined`, throwing, or
  rejecting still keeps the queue and shows **Submit failed**. Without a handler,
  Submit remains hidden and the queue is kept.
