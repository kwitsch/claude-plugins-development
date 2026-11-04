#!/usr/bin/env bash
# Usage: check-plugin-fresh.sh <plugin>  (run after `pnpm --filter <plugin> build`)
# Fails when the committed <plugin>/plugin/ differs from the fresh build (modified or untracked files).
set -euo pipefail
p=$1
test -z "$(git status --porcelain -- "$p/plugin")" || {
  echo "::error::$p/plugin is stale or has untracked build output; run pnpm --filter $p build and commit"
  exit 1
}
# plugin/ ships only build output and hand-written plugin files (.claude/rules/plugin-build-output.md)
bad=$(find "$p/plugin" \( -name '*.ts' -o -name '*.mts' -o -name '*.test.*' -o -name CLAUDE.md -o -path '*/tests' \) -print)
test -z "$bad" || {
  echo "::error::$p/plugin holds sources/tests that belong in src/ or tests/: $bad"
  exit 1
}
