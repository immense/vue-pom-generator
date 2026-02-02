---
name: Agentic Release Notes
description: Agentic PR release notes preview (prompt rev 8)

on:
  pull_request:
    branches:
      - main

permissions: read-all

safe-outputs:
  add-comment:
    max: 1

timeout-minutes: 22

network: defaults

steps:
  - name: Checkout repository
    uses: actions/checkout@v4
    with:
      fetch-depth: 0

tools:
  bash:
    - "*"

engine:
  id: copilot
  model: gpt-4.1
---

# Agentic Release Notes

Generate suggested GitHub release notes in Markdown for this pull request.

## Output requirements (must follow)

- You MUST add exactly one pull request comment using the `output.add-comment` safe output.
- The PR comment body MUST start with this exact first line (no leading whitespace):
  `<!-- vue-pom-generator:agentic-release-notes-preview -->`
- The PR comment body MUST NOT contain the backtick character (`) anywhere.
- The first character of the PR comment body MUST be `<`.
- Do NOT wrap any part of the output in code fences.
- If you cannot comply with these requirements, do NOT add a comment; instead use `output.noop` with a short explanation.

## Instructions

1. Read the pull request context:
  - Do NOT use GitHub tools.
  - Use the workflow context to derive the PR number and repository, and include a PR link.

2. Determine changed files locally:
  - Use `git fetch` to ensure the base branch is present.
  - Compute the changed file list using `git diff` between the base branch and the PR HEAD.
  - If you need more detail for a specific file, inspect it with `git diff` for that file only.

3. Bash tool usage constraints:
  - Fail fast: do not use `|| true` or other silent recovery.
  - Keep tool output small: do not print long diffs or the final Markdown to stdout.
    - Write any large outputs to files instead.
    - Only print short status lines (counts / filenames) if needed.

4. Summarize only what is in this PR:
  - Do not include unrelated changes from main.
  - Do not invent changes.

5. Write release notes in this exact structure:

- `## Highlights` (3–6 bullets)
- `## Changes` (bulleted; grouped by theme if possible)
- `## Breaking Changes` (only if any)
- `## Pull Requests Included` (bulleted, with PR links)
- `## Testing` (short; mention what signals you have)

## Output

- Also write the final Markdown to `$GITHUB_STEP_SUMMARY` so it appears in the workflow run summary.
- Do not invent changes; only summarize what you can justify from the collected evidence.
