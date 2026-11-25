#!/usr/bin/env bash
# Usage: changed-plugins.sh <from> <to>   (run in a checkout of <to>)
# Prints the plugin dirs whose files changed between the two commits, plus every plugin aliasing @shared when
# development/shared/src/ changed (a build input of each of them, see ships.sh). Used by pr.yml and release.yml.
set -euo pipefail
files=$(git diff --name-only "$1" "$2")
dirs=$(cut -d/ -f1 <<<"$files")
if grep -q '^development/shared/src/' <<<"$files"; then
  dirs+=$'\n'$(grep -ls '@shared' ./*/tsdown.config.ts | cut -d/ -f2 || true)
fi
sort -u <<<"$dirs" | while read -r d; do
  if [ -n "$d" ] && bash "$(dirname "$0")/is-plugin.sh" "$d"; then echo "$d"; fi
done
