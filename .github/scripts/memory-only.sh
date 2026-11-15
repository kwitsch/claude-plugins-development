#!/usr/bin/env bash
# Usage: memory-only.sh <plugin dir> <git diff range...>   e.g. memory-only.sh jevfort origin/main...HEAD
# Exit 0 when the diff changes files under <plugin dir>/ and every one of them is Claude memory: a CLAUDE.md at any
# depth or a file under <plugin dir>/.claude/ (path-scoped rules). Such a change ships nothing, so it needs no version
# bump and no release (pr.yml, release.yml). Exit 1 otherwise, also when nothing under the plugin changed.
set -euo pipefail
p=$1
shift
files=$(git diff --name-only "$@" -- "$p/")
[ -n "$files" ] || exit 1
while IFS= read -r f; do
  case "$f" in
  "$p"/.claude/* | */CLAUDE.md) ;;
  *) exit 1 ;;
  esac
done <<<"$files"
exit 0
