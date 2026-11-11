---
id: F15
title: Re-arm FileChanged watches after git checkout (prototype first)
status: done
priority: medium
area: universal-lint/.claude/rules/hook-design.md, universal-lint/docs/TASKS.md
---

## Status

Done in 0.15.13, docs-only. Prototype on Claude Code 2.1.319 (2026-11-08) showed approach 1 (re-emit the list) is a no-op and the loss is limited to files Claude Code reported as `unlink`; no code shipped. Upstream report text below. 0.15.13 because F13 (0.15.12) merges and is tagged first; the root CLAUDE.md rule applies to any change under `universal-lint/`, and all four deliverables live there.

## Problem

Claude Code watches each watchPaths file individually. On 2.1.319 a `git checkout` loses the watch only on the files Claude Code reported as `unlink` (1 and 3 of 50 in the two non-churning runs; 9 unlink reports in the churning toggle run, all re-armed). Files that survive unlink+create without an `unlink` report keep delivering. Files created after SessionStart/CwdChanged stay unwatched until the next SessionStart/CwdChanged (unchanged). The unlink fraction was measured on a local tmp filesystem; a slower filesystem (9P `/mnt/c`) may report more.

## Evidence

(a) Original session, 0.14.0, not reproduced on 2.1.319: `claude -p`, debug log: `provided 63 watchPaths`, `FileChanged: watching 63 paths`; a 50-file in-place change gave 50 change events; `git checkout -- scripts` gave 48 change + 2 unlink; a second 50-file change on the same files gave 0 events. `fs.watch` on a tracked file, then `git checkout -- file` gave change, rename, rename; a later append produced nothing. A build in the live run produced 2 unlink events and the rebuilt files left the watch list. dprint F24 measured the same collapse (135 -> 15 inotify watches). The hooks reference lists `watchPaths` as valid FileChanged output (replacing the dynamic list).

(b) Prototype, Claude Code 2.1.319, headless `claude -p`, flat scratch repo with 50 tracked files, scenario: phase A 50 in-place appends, `git checkout -- .` (phase B), phase C 50 in-place appends. One run per mode.

| mode   | isolated         | watcher lines (`FileChanged: watching N paths`)                                                  | FileChanged payloads A / B / C               | FileChanged emits                                                                | dead in C                          |
| ------ | ---------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------- |
| none   | yes              | 1 (50 paths)                                                                                     | 50 change / 49 change + 1 unlink / 49 change | 0                                                                                | f43 (the unlinked file)            |
| always | no               | 2 (50 paths; the second at 16:56:58Z, after the first FileChanged batch settled, before phase B) | 50 / 47 change + 3 unlink / 47               | 147 (one per payload; 97 of them after the unlinks, none re-created the watcher) | f22, f35, f38 (the unlinked files) |
| toggle | yes (second run) | 92 (59 x 49 paths, 33 x 50 paths)                                                                | 50 / 0 change + 9 unlink / 50                | 109                                                                              | none                               |
| dir    | yes              | 1 (1 path)                                                                                       | 50 / 51 (50 files + `.git/index`) / 50       | 0                                                                                | none                               |

`debug-toggle-proto.txt` holds two runs (run.sh never deletes debug files); the first, non-isolated run (67 watcher lines) is excluded.

Modes: `none` = hook emits no watchPaths (baseline); `always` = every SessionStart/FileChanged emits the identical sorted 50-file list; `toggle` = alternates full list / full list minus the changed file; `dir` = emits `[cwd]` (the repo directory) once at SessionStart. `none`, `dir` and the second `toggle` run were isolated (`--settings iso-settings.json` from 16:59:40Z); the `always` run and the first `toggle` run were NOT (installed universal-lint 0.15.0, dprint 0.11.2 and ponytail hooks active; the universal-lint 0.15.0 FileChanged hook ran on every event of the `always` run).

Conclusions:

1. FileChanged stdout `watchPaths` is honoured under `asyncRewake` (exit 0 + JSON first line; findings still stderr + exit 2). Proof: the `watching 49 paths` lines of the toggle run.
2. Re-emitting the identical list is a no-op: Claude Code re-creates the watcher only when the sorted list changes. The second `always` watcher line occurred after phase A, before phase B, when the first FileChanged hook batch settled; the 97 identical emits after the three unlinks produced no re-creation and the three files stayed silent in phase C.
3. A changing list re-arms but churns: 92 re-creations for 109 emits; 41 of 50 files produced no event in phase B, the other 9 only `unlink`.
4. No loop: 110 emits for 110 payloads (1 SessionStart + 109 FileChanged), one per payload; the last emit 6 ms after the last payload, the last watcher re-creation 0.35 s after the first phase-C write, nothing in the following 6 s.
5. Per-file loss is limited to unlink-reported files (1 and 3 of 50 in the non-churning runs).
6. A `[cwd]` directory watch delivers 50/50 in phases A and C, with one `.git/index` event in B and no churn.

## Prototype harness

Recipe, so it can be rebuilt (the session scratchpad is ephemeral; no durable paths):

- Scratch git repo with 50 tracked files `f1.mjs`..`f50.mjs`.
- Throwaway plugin dir with `.claude-plugin/plugin.json`, `hooks/hooks.json` registering SessionStart (sync) and FileChanged (`asyncRewake: true`) only, no CwdChanged, and `hooks/proto.mjs`, which appends each payload to `$PROTO_LOG` and prints `{"hookSpecificOutput":{"hookEventName":<event>,"watchPaths":[...]}}` per `PROTO_MODE` (`none`, `unlink`, `always`, `toggle`, `dir`).
- Scenario: 50 in-place appends, 6 s, `git checkout -- .`, 6 s, 50 in-place appends.
- Run `claude -p --plugin-dir <proto> --debug-file <log> --settings <iso.json>`; `iso.json` sets `enabledPlugins` to false for installed plugins (isolated runs). Delete the debug file between runs. Count distinct files per phase from the payload log and `FileChanged: watching N paths` lines from the debug file.
- `provided N watchPaths` is logged for SessionStart hooks only, never for a FileChanged emit; the proof that FileChanged stdout watchPaths is honoured is the `watching 49 paths` lines of the toggle run.
- Caveats: single run per mode; `none`, `dir` and the second `toggle` run isolated, `always` and the first `toggle` run not (see Evidence); `--settings` does not disable hooks from `~/.claude/settings.json`; flat repo only; local tmp filesystem only.

## Why no code

- Watch paths are honoured, but an identical re-emit never re-creates the watcher, so re-emitting after `unlink` cannot re-arm the dead files (97 identical emits after three unlinks; the three files stayed silent).
- A changing list (toggle) does re-arm, but churns (92 re-creations for 109 emits) and loses events during the very checkout it should cover (41 of 50 files produced no event in phase B, the other 9 only `unlink`).
- Directory watchPaths worked 50/50 in the flat repo, but in a real repo every `.git`, build-output and `node_modules` write would spawn a hook process (about 45-50 ms each per F11); not measured, so not shipped.
- Cost note: every re-emit from FileChanged means one full `watchList` (`git ls-files` plus up to 5000 `scopedTarget` calls) per event.

## Upstream report (ready to file)

Title: FileChanged: per-file watch is lost for files reported as unlink after git checkout; re-emitted identical watchPaths cannot re-arm

Environment: Claude Code 2.1.319, Linux (WSL2), headless `claude -p`, command hook with `asyncRewake: true` on FileChanged and a SessionStart command hook emitting `hookSpecificOutput.watchPaths`. `none`, `dir` and the second `toggle` run were isolated (`--settings` with `enabledPlugins` false for installed plugins); `always` and the first `toggle` run were not (other plugins' hooks active).

Steps: flat git repo with 50 tracked files watched per file via watchPaths; phase A: 50 in-place appends; phase B: `git checkout -- .`; phase C: 50 in-place appends.

Observed:

| mode   | isolated         | watcher lines (`FileChanged: watching N paths`)                                                  | FileChanged payloads A / B / C               | FileChanged emits                                                                | dead in C                          |
| ------ | ---------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------- |
| none   | yes              | 1 (50 paths)                                                                                     | 50 change / 49 change + 1 unlink / 49 change | 0                                                                                | f43 (the unlinked file)            |
| always | no               | 2 (50 paths; the second at 16:56:58Z, after the first FileChanged batch settled, before phase B) | 50 / 47 change + 3 unlink / 47               | 147 (one per payload; 97 of them after the unlinks, none re-created the watcher) | f22, f35, f38 (the unlinked files) |
| toggle | yes (second run) | 92 (59 x 49 paths, 33 x 50 paths)                                                                | 50 / 0 change + 9 unlink / 50                | 109                                                                              | none                               |
| dir    | yes              | 1 (1 path)                                                                                       | 50 / 51 (50 files + `.git/index`) / 50       | 0                                                                                | none                               |

Key observation: in the `always` run the second watcher line occurred after phase A, before phase B, when the first FileChanged hook batch settled; the 97 identical emits after the three unlinks produced no re-creation, and the three unlinked files stayed silent in phase C. With a changing list (toggle) the watcher was re-created 92 times for 109 emits and 41 of 50 files produced no event in phase B, the other 9 only `unlink`.

Expected / ask: either re-arm a watched path after its inode is replaced (re-stat after `unlink`), or honour a re-emitted identical watchPaths list as a re-arm request. Related measurement: dprint F24 saw 135 -> 15 inotify watches after a checkout on an older version.

## Follow-ups

- Directory-watch flood measurement in a real repo: count events per `git checkout`, per-event hook spawns, and inotify watches via `/proc/<pid>/fdinfo`; covers `.git`, build output, `node_modules` and subdirectories; needed before designing a hook-side filter.
- Once-per-checkout re-arm: emit the list plus a changing sentinel path from the last FileChanged of a burst (coalesced like the F13 lock); not prototyped, needs a run showing the sentinel is accepted and a post-burst re-creation re-arms the unlink-reported files without loss.
- Refreshing the watch list after Bash commands (already noted in hook-design.md).

## Related

F12, F08, F19, F33, dprint F24 (`dprint/docs/tasks/F24-watch-list-static-per-file.md`, whose approach 2 assumes the mcp_tool result path honours watchPaths; the F15 prototype covers only the command-hook path, so dprint F24 still needs its own prototype).
