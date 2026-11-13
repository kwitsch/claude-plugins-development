---
id: F24
title: Make the FileChanged watch list survive new files and git checkout
status: open
priority: high
area: dprint/src/mcp/watch-paths.mts (watchList, main), dprint/src/mcp/format.mts (fileChanged), dprint/plugin/hooks/hooks.json (SessionStart/CwdChanged command hook)
---

## Status

Reviewed 2026-11-13; live smoke test below confirms the problem (priority back to high). Designs depend on Claude Code watcher behavior (re-creation on an unchanged sorted list, honoring watchPaths from an mcp_tool FileChanged result, directory-watch event volume without `ignored`) that only a live `claude -p --plugin-dir dprint/plugin --debug` run with an inotify sampler can prove. Mitigated for Bash: `bash_finished` formats rewritten watched files via an mtime scan of the cached list. Still uncovered: files rewritten by non-Bash tools after a watch is lost, and new files (watch list and `bash_finished` cache are read once per cwd). The list is sorted since 0.12.1. Next step: live prototype of directories as watchPaths (option 2, re-list from FileChanged, was prototyped and does not work, see below).

Open. Explicitly deferred in the 0.8.0 work (branch feature/performance-analysis-fixes, PR #19) as an unprototyped redesign. Analysis ranks it #2 by user impact; it limits the value of the F05 burst fix after the first checkout.

## Live smoke test (2026-11-13, Claude Code 2.1.323, plugin 0.13.0)

Method: `claude -p --plugin-dir dprint/plugin --debug-file ... --allowedTools Bash` in a throwaway git repo (5 tracked unformatted `*.ts`, root `dprint.json`), one Bash call `sleep 60` keeps the session alive; a harness outside edits files and counts inotify watches of the claude process (`/proc/<pid>/fdinfo`). Debug log: `FileChanged: watching 6 paths` (SessionStart `watchPaths` of watch-paths.mjs is honored). Two runs, same script:

| Scenario                                                 | Run 1                   | Run 2                         |
| -------------------------------------------------------- | ----------------------- | ----------------------------- |
| in-place write of a watched file (control)               | formatted               | formatted                     |
| delete + recreate a watched file (1st time)              | formatted               | formatted, watch count 9 -> 8 |
| delete + recreate again                                  | formatted               | NOT formatted, no event       |
| in-place write after that                                | formatted               | NOT formatted, no event       |
| brand-new file                                           | NOT formatted           | NOT formatted                 |
| `git checkout -- f` (unlink+create), then in-place write | NOT formatted, no event | NOT formatted, no event       |
| watch count start / end                                  | 9 / 7                   | 9 / 0                         |

Findings: (1) new files are never watched: confirmed. (2) A watched file that is unlinked and recreated loses its watch, racily (run 1 survived a quick delete+recreate twice, run 2 lost the watch at the first one; after `git checkout` the watch was gone in both runs): confirmed, and the watch count only falls. (3) 9 inotify watches for 6 listed files (the other 3 were not attributed). Not tested: directories as `watchPaths`, `watchPaths` returned by a FileChanged hook (needs a prototype; with the loss being racy a re-list after an `unlink` event, as in option 2, is the design the data points to, but an unlink event is not even delivered after the loss). Scripts: scratchpad `f24-run.mjs` (not in the repo).

## Prototype result (2026-11-13, Claude Code 2.1.323): re-list via FileChanged `watchPaths`, not shipped

Prototype (reverted): `file_changed` re-read `dprint file-paths` (sorted, in scope, one shared listing per second) and returned it as `hookSpecificOutput.watchPaths`, first on `unlink` events, then after every `change` event. Same harness as above, 3 runs per variant.

- **`unlink` trigger: dead.** Claude Code never delivers an `unlink` event to FileChanged hooks here: the debug log shows only `change` events, also for deleted-and-recreated files and after `git checkout`. A re-list on `unlink` never ran (0 of 3 runs).
- **`watchPaths` from a FileChanged `mcp_tool` hook is honored:** the log shows a second `FileChanged: watching N paths` right after the event (once with 7 paths when a new file had appeared).
- **Re-list on every `change` event: partial at best.** The watch count at the end of the run was 9, 9, 0 (baseline without it: 7, 0, 7), but a second delete-and-recreate, an in-place write afterwards, a new file and the write after `git checkout` were still not formatted in 2 of 3 runs. The re-list answers the event of a file whose watch is about to be lost; the loss happens after it and nothing re-arms the watch.
- Cost of that variant: one `dprint file-paths` per change burst (about 55 ms for 100 files, 160 ms for 5000), and 6 tests that expect `{}` from `file_changed` fail.

Conclusion: re-listing from FileChanged does not fix the loss; do not ship it. Untested next candidates: directories as `watchPaths` (Claude Code would watch directories, so unlink+create of a child cannot drop the watch; open questions: event volume from `.git`/`node_modules` and whether Claude Code accepts directories) and a SessionStart/CwdChanged-style refresh at another trigger (no hook event fires on loss).

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
