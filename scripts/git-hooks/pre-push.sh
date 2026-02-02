#!/usr/bin/env bash
set -euo pipefail

# Only enforce on pushes from the main branch.
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$CURRENT_BRANCH" != "main" ]; then
  exit 0
fi

# Ensure we have an up-to-date view of origin/main.
# We fail fast (no auto-fix) to keep behavior explicit.
git fetch origin main --quiet

# Compare local main against origin/main.
# Output format: "<behind>\t<ahead>"
COUNTS="$(git rev-list --left-right --count origin/main...HEAD)"
BEHIND="${COUNTS%%$'\t'*}"
AHEAD="${COUNTS##*$'\t'}"

if [ "${BEHIND}" -gt 0 ]; then
  echo "" 1>&2
  echo "Blocked push: local 'main' is behind origin/main by ${BEHIND} commit(s)." 1>&2
  echo "Run: git pull --rebase --autostash" 1>&2
  echo "Then re-run: git push" 1>&2
  echo "" 1>&2
  exit 1
fi

# If we're not behind, allow the push. (AHEAD can be 0 or more.)
exit 0
