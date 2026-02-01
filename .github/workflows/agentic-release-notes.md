---
name: Agentic Release Notes

on:
  pull_request:
    branches:
      - main

permissions: read-all

safe-outputs:
  add-comment:
    max: 1

timeout-minutes: 20

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
  model: gpt-5
---

# Agentic Release Notes

Generate suggested GitHub release notes in Markdown for this pull request.

## Instructions

1. Read the pull request context:
  - Do NOT use GitHub tools.
  - Use the workflow context to derive the PR number and repository, and include a PR link.

2. Determine changed files locally:
  - Use `git fetch` to ensure the base branch is present.
  - Compute the changed file list using `git diff` between the base branch and the PR HEAD.
  - If you need more detail for a specific file, inspect it with `git diff` for that file only.

3. Summarize only what is in this PR:
  - Do not include unrelated changes from main.
  - Do not invent changes.

4. Write release notes in this exact structure:

- `## Highlights` (3–6 bullets)
- `## Changes` (bulleted; grouped by theme if possible)
- `## Breaking Changes` (only if any)
- `## Pull Requests Included` (bulleted, with PR links)
- `## Testing` (short; mention what signals you have)

## Output

- Output only Markdown.
- Also write the final Markdown to `$GITHUB_STEP_SUMMARY` so it appears in the workflow run summary.
- Do not invent changes; only summarize what you can justify from the collected evidence.
- You MUST add a pull request comment containing the Markdown using the `output.add-comment` safe output.
- Start the comment body with: `<!-- vue-pom-generator:agentic-release-notes-preview -->`
- Do NOT wrap the output in code fences.
