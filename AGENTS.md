# AGENTS.md

This repository is often edited by automated coding agents.

## Hard rules (do not ignore)

- **Do not add fallback code paths**.
  - No "try X, else Y" compatibility behavior.
  - No silent recovery or alternate behavior to preserve legacy callers.
  - If something is invalid, **fail fast** (throw/error) or update all call sites.

- **Do not add deprecation fallbacks / compatibility shims**.
  - No deprecated aliases (e.g., exporting old names alongside new names).
  - No transitional wrappers that keep previous behavior alive.
  - No "deprecated" exports kept for downstream compatibility unless explicitly requested.

- If a change is breaking, **make it fully breaking**:
  - Rename/remove the symbol.
  - Update every internal usage.
  - Update tests.
  - Update generated typings/artifacts as needed.

## When you think a fallback is needed

Stop and ask for guidance instead of implementing a fallback. Explain:

- what would break,
- which consumers/call sites are affected,
- and what the clean breaking change would look like.

## Scope

These rules apply to:

- TypeScript/JavaScript source,
- tests,
- build outputs checked into the repo (e.g. `dist/*.d.ts`) when they must be edited.
