---
id: F22
title: FileChanged skip without a git status spawn (index blob id)
status: open
priority: low
area: universal-lint/src/hooks/lint-file.mts (fileChangedHandler, watchList)
---

# F22 FileChanged skip without a git status spawn

## Status

Open. real-sessions finding (confirmed, low; 9P only, no 9P sessions in the transcripts). The skip path already matches dprint F06's single-spawn design; this removes the spawn entirely.

## Problem

Each FileChanged event spawns node plus `git status` for one file to detect "tracked and unchanged". Branch switches, rebases, pulls and stashes produce one event per changed watched file, all at once.

## Evidence

Unchanged tracked file: ext4 41-51 ms, 50k-file index 61-100 ms, /mnt/c blocky-dev 202-340 ms (git status 139-180 ms). Transcripts: 576 git merge/rebase/pull/stash/reset and 186 checkout/switch/restore Bash calls, plus 847 builds and 389 `sed -i`, across 22,730 Bash calls.

## Code locations

`fileChangedHandler` (`execFileSync("git", ["--no-optional-locks", "status", "--porcelain", "--untracked-files=normal", "--ignored=matching", "--", fp])`); `watchList`.

## Approach

When the watch list is built, also store path → index blob id (`git ls-files -s -z`) under CLAUDE_PLUGIN_DATA. In `fileChangedHandler`, compute the git blob SHA-1 in-process (`sha1("blob " + len + "\0" + content)`); equal → skip; otherwise fall back to today's git status. Only worth it if 9P or very large repos matter.

## Verification

Test: an unchanged tracked file → no git spawn (stub git records nothing), exit 0; a changed file → git status path as today. 9P: about 70 ms instead of about 210 ms.

## Constraints

autocrlf/clean filters can make worktree bytes differ from the blob: on mismatch always fall back to git status (fail toward linting). The stored map goes stale after commits: mismatch only means a git spawn. Version bump.

## Related

F10, F12, F01 (skip-path baseline), dprint F06.
