#!/usr/bin/env bash
# Usage: ships.sh <plugin dir> <from> <to>   (run in a checkout of <to>)   e.g. ships.sh jevfort "$(git merge-base origin/main HEAD)" HEAD
# Prints what changed for the plugin between the two commits:
#   ship     build inputs and version changed: the only case release.yml tags and syncs. A version bump also counts the
#            inputs changed since the previous release (tag <plugin>-<old version>), so a change merged without a bump
#            (Dependabot) ships with the next bump
#   content  build inputs changed, version did not: pr.yml fails (Dependabot excepted), release.yml skips it
#   version  version changed, build inputs did not (also not since the previous release): nothing ships
#   none     neither (tests, scripts/, claude-tests/, CLAUDE.md, .claude/; plugin/ is git-ignored build output)
# Build inputs: the `inputs` and `manifest` lines below; the readable list and the reasons are in .claude/rules/ci.md.
set -euo pipefail
p=$1 from=$2 to=$3
git rev-parse --verify -q "$from^{tree}" >/dev/null # --verify takes exactly one revision: one line per end
git rev-parse --verify -q "$to^{tree}" >/dev/null
pkg() { # jq filter over package.json at a commit; empty when it does not exist there (new plugin)
  if git cat-file -e "$1:$p/package.json" 2>/dev/null; then git show "$1:$p/package.json" | jq -c "$2"; fi
}
inputs=("$p/src/" "$p/assets/" "$p/hooks.template.json" "$p/mcp.template.json" "$p/tsdown.config.ts")
if grep -qs '@shared' "$p/tsdown.config.ts"; then inputs+=(development/shared/src/); fi
# only the build script can change the output; shortcut: a build script that runs another script of the package.json is not followed
manifest='del(.version) | .scripts |= {build}'
inputs_changed() { ! git diff --quiet "$1" "$2" -- "${inputs[@]}" || [ "$(pkg "$1" "$manifest")" != "$(pkg "$2" "$manifest")" ]; }
content=0 version=0
if inputs_changed "$from" "$to"; then content=1; fi
old=$(pkg "$from" .version)
if [ "$old" != "$(pkg "$to" .version)" ]; then
  version=1
  rel=$(git rev-parse -q --verify "refs/tags/$p-$(tr -d '"' <<<"$old")^{commit}" || true) # empty: no tag, or a new plugin
  if [ "$content" = 0 ] && [ -n "$rel" ] && inputs_changed "$rel" "$to"; then content=1; fi
fi
case $content$version in 11) echo ship ;; 10) echo content ;; 01) echo version ;; *) echo none ;; esac
