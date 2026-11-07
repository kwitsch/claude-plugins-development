---
id: F15
title: Re-arm FileChanged watches after git checkout (prototype first)
status: open
priority: medium
area: universal-lint/src/hooks/lint-file.mts (fileChangedHandler, watchList, watchPathsHandler), universal-lint/plugin/hooks/hooks.json, universal-lint/.claude/rules/hook-design.md
---

# F15 Re-arm FileChanged watches after git checkout

## Status

Open, prototype first. watch-filechanged finding (confirmed, medium). Coverage gap more than a performance item; shared problem with dprint F24.

## Problem

Claude Code watches each watchPaths file individually. `git checkout`/`restore` replaces files via unlink+create, which kills the watch on every rewritten file, not only those reported as `unlink`. After one checkout, FileChanged is dead for all touched files until the next SessionStart/CwdChanged. hook-design.md lists "replaced by unlink+create" as a static-list residual but not its scale.

## Evidence

Real session (`claude -p`, 0.14.0, debug log): `provided 63 watchPaths`, `FileChanged: watching 63 paths`; a 50-file in-place change gave 50 change events; `git checkout -- scripts` gave 48 change + 2 unlink; a second 50-file change on the same files gave 0 events. `fs.watch` on a tracked file, then `git checkout -- file` → change, rename, rename; a later append produced nothing. A build in the live run produced 2 unlink events and the rebuilt files left the watch list. dprint F24 measured the same collapse (135 → 15 inotify watches). The hooks reference lists `watchPaths` as valid FileChanged output (replacing the dynamic list).

## Code locations

`fileChangedHandler` (returns `{}` for `unlink`, never outputs watchPaths); `watchList`; `watchPathsHandler`; hooks.json FileChanged entry; hook-design.md "Static watch list (dprint F24)".

## Approach

1. Prototype: does Claude Code honour `hookSpecificOutput.watchPaths` on stdout from a FileChanged command hook that runs with `asyncRewake` (exit 0 + JSON on stdout; findings use exit 2 + stderr)? If yes: re-emit the sorted watch list from FileChanged after an `unlink` event (or when a cheap stat shows a new inode), rate-limited by a marker file under CLAUDE_PLUGIN_DATA so a 50-file checkout does not run 50 `git ls-files`. Claude Code re-creates the watcher only when the sorted list changes; check that it does not loop.
2. Otherwise try directories as watchPaths and measure the event flood (`.git`, build output).
3. Report the per-file watch loss upstream with these numbers either way; coordinate with dprint F24.

## Verification

Repeat the session (50-file change, `git checkout`, 50-file change) with `claude -p --plugin-dir universal-lint/plugin --debug-file`: the second change yields 50 events again and `FileChanged: watching N paths` stays at 63. Unit test: a FileChanged unlink payload returns sorted watchPaths at most once per rate-limit window.

## Constraints

Needs Claude Code behaviour confirmation first. Re-emission multiplies watch-list cost (do F12 first). Fail open; zero-dependency; TSDoc; version bump.

## Related

F12, F08, F19, F33, dprint F24.
