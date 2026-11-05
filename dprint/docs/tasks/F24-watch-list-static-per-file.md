---
id: F24
title: Make the FileChanged watch list survive new files and git checkout
status: open
priority: high
area: dprint/src/mcp/watch-paths.mts (watchList, main), dprint/src/mcp/format.mts (fileChanged), dprint/plugin/hooks/hooks.json (SessionStart/CwdChanged command hook)
---

# F24 Make the FileChanged watch list survive new files and git checkout

## Status

Open. Explicitly deferred in the 0.8.0 work (branch feature/performance-analysis-fixes, PR #19) as an unprototyped redesign. Analysis ranks it #2 by user impact; it limits the value of the F05 burst fix after the first checkout.

## Problem

`watch-paths.mjs` prints `hookSpecificOutput.watchPaths` = the individual files `dprint file-paths` lists at SessionStart/CwdChanged. Claude Code (chokidar) creates one inotify watch per FILE, no directory watch. Consequences:

- Files created mid-session (Write of a new file, codegen, `git checkout` adding files) never get an event until the next CwdChanged/SessionStart re-list.
- A watched file that is unlinked (git checkout writes unlink+create, delete+recreate saves) loses its watch; chokidar's listener stats the file, ENOENT -> unlink event, path dropped. After one `git checkout` rewriting 120 watched files the watch count fell 135 -> 15 and every later checkout/restore produced 0 events: FileChanged formatting is dead for the rest of the session on exactly the targeted files. A 6.5 MB JSON replaced by git arrived as one `unlink` and was never formatted. Every session ends with fewer watches than it started.
  Root cause is Claude Code's per-file chokidar watching racing git's unlink+create (outside the plugin), but the file-list design exposes it.

## Evidence

Sessions burst-A/B (checkout burst + Write of a new file, checkout main, `git restore --source=burst -- src/burst`), bigjson, baseline: inotify watch count sampled from /proc/<claude pid>/fdinfo (`inotify_wd=`): 135 (132 files + 3 Claude dirs) -> 130 -> 15 after `git checkout main`; burst-B 135 -> 15 after the first checkout (120 events: 117 change + 3 unlink), then 0 events for checkout main and restore (120 files left unformatted). New files src/during.ts, src/new.ts, notes2.md: 0 events in 4 cases. In-place append to a watched file did arrive as `change`. Docs: watchPaths replaces the dynamic list; Claude Code only re-creates the watcher when the sorted list changes. Not run: the CwdChanged re-listing and any directory-as-watchPaths prototype.

## Code locations

- `watchList` and `main` in dprint/src/mcp/watch-paths.mts (`dprint file-paths`, `WATCH_LIMIT`, `inScope` filter; prints files only).
- `fileChanged` in dprint/src/mcp/format.mts (handles `change`/`add`/`unlink`; `unlink` is ignored).
- dprint/plugin/hooks/hooks.json: SessionStart + CwdChanged `command` hook (watch-paths.mjs) and FileChanged `file_changed` mcp_tool hook.

## Approach

Prototype FIRST (nothing is validated); decision it gates: which of the two designs ships.

1. Directories as watchPaths (emit the dirs containing formatted files, or the cwd): chokidar then watches directories and reports add/unlink/change by name. MEASURE the event flood first: Claude Code sets no `ignored` option, so `.git`, `node_modules`, build output inside the cwd would all fire; check inotify watch count and events per `git checkout`, and that `fileChanged` filters non-dprint files cheaply (it gates on `findConfig`, `inScope`, and digest before any spawn). Directory entries must be real in-scope directories (use `inScope`/`scopeOf` semantics; skip `.git`, node_modules, scratchpad dir).
2. Re-emit the file list from a FileChanged hook result after an `unlink` event (hook output `watchPaths`) so Claude re-creates the watcher. Needs `fileChanged` to return `hookSpecificOutput.watchPaths` and to share the listing code with watch-paths.mts (watch-paths.mjs must NOT import server.mjs; server importing it must not auto-run `main`). Check that the sorted-list comparison triggers re-creation and does not loop (also: `dprint file-paths` order is nondeterministic, sort the output).
3. Report the per-file watch loss to Claude Code with the burst-B numbers regardless.
   Interactions: WATCH_LIMIT (5000, counts raw files) and F25 cost scale with the design; directories shrink the list and the SessionStart JSON dramatically.

## Verification

Offline: unit/integration test in dprint/tests/mcp-server.test.mts or a new test running `plugin/mcp/watch-paths.mjs` (existing tests at "watch-paths.mjs prints the in-cwd dprint file paths as watchPaths ..." show the harness). Real-session proof needs a headless `claude -p` run with `--plugin-dir dprint/plugin --debug` and an inotify watch-count sampler (`grep -c inotify /proc/<pid>/fdinfo/*`): create a new file, run `git checkout` rewriting watched files twice, assert events keep arriving and watch count stays stable.

## Constraints

Edit src/ not plugin/*.mjs; `pnpm --filter dprint build && pnpm --filter dprint test`; fail open; zero-dep node:; TSDoc on every symbol; keep watch-paths.mts free of a server.mjs import; version bump in dprint/plugin.json AND dprint/package.json.

## Related

F05 (burst handling: only matters after the first checkout if F24 is fixed), F25 (list size/cost, WATCH_LIMIT), F26 (JSON size), F04 (large rewritten files), F13.
