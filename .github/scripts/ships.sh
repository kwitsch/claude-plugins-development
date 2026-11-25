#!/usr/bin/env bash
# Usage: ships.sh <plugin dir> <from> <to>   (run in a checkout of <to>)   e.g. ships.sh jevfort "$(git merge-base origin/main HEAD)" HEAD
# Prints what changed for the plugin between the two commits:
#   ship     build inputs and version changed: the only case release.yml tags and syncs
#   content  build inputs changed, version did not: pr.yml fails (Dependabot excepted), release.yml skips it (a later bump-only commit is "version", so the change never ships)
#   version  version changed, build inputs did not: nothing ships
#   none     neither (tests, scripts/, claude-tests/, CLAUDE.md, .claude/; plugin/ is git-ignored build output)
# Build inputs: package.json apart from version and the test/lint scripts, src/, assets/, hooks.template.json,
# mcp.template.json, tsdown.config.ts, and development/shared/src/ when tsdown.config.ts aliases @shared.
set -euo pipefail
p=$1 from=$2 to=$3
git rev-parse --verify -q "$from^{tree}" >/dev/null # --verify takes exactly one revision: one line per end
git rev-parse --verify -q "$to^{tree}" >/dev/null
pkg() { # jq filter over package.json at a commit; empty when it does not exist there (new plugin)
  if git cat-file -e "$1:$p/package.json" 2>/dev/null; then git show "$1:$p/package.json" | jq -c "$2"; fi
}
inputs=("$p/src/" "$p/assets/" "$p/hooks.template.json" "$p/mcp.template.json" "$p/tsdown.config.ts")
if grep -qs '@shared' "$p/tsdown.config.ts"; then inputs+=(development/shared/src/); fi
manifest='del(.version, .scripts.test, .scripts.lint, .scripts["test:plugin"])'
content=0 version=0
if ! git diff --quiet "$from" "$to" -- "${inputs[@]}" || [ "$(pkg "$from" "$manifest")" != "$(pkg "$to" "$manifest")" ]; then content=1; fi
if [ "$(pkg "$from" .version)" != "$(pkg "$to" .version)" ]; then version=1; fi
case $content$version in 11) echo ship ;; 10) echo content ;; 01) echo version ;; *) echo none ;; esac
