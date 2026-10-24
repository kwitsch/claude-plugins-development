#!/usr/bin/env bash
# Usage: check-plugin-fresh.sh <plugin>  (run after `pnpm --filter <plugin> build`)
# Fails when the committed <plugin>/plugin/ differs from the fresh build (modified or untracked files).
set -euo pipefail
p=$1
test -z "$(git status --porcelain -- "$p/plugin")" || {
  echo "::error::$p/plugin is stale or has untracked build output; run pnpm --filter $p build and commit"
  exit 1
}
