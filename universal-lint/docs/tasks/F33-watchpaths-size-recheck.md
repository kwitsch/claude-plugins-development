---
id: F33
title: watchPaths JSON size and watch count need no change; re-check on Claude Code upgrades
status: done
priority: low
area: universal-lint/src/hooks/lint-file.mts (watchPathsHandler, watchList, WATCH_LIMIT)
---

## Status

Closed docs-only in 0.15.29. watch-filechanged finding (confirmed, low): re-checked on Claude Code 2.1.321, no cap appeared, no code change. The re-check recipe in Approach stays for future upgrades.

## Problem

`WATCH_LIMIT` counts files, not bytes, so the SessionStart stdout can reach about 0.66-1.1 MB depending on path length (657,670 B measured at 4800 paths with a 126-character cwd prefix, see Measured on 2.1.321), and Claude Code creates one watch per file. Open question (answered on 2.1.321: no cap on 4800 paths): does a future Claude Code cap hook stdout or watch counts?

## Evidence

About 180-200 bytes per path: 2275 paths 412,588 bytes; 3000 paths 595 KB; 4800 paths 953 KB-1.1 MB. Real sessions parsed 34 and 63 paths (`provided 63 watchPaths`, `FileChanged: watching 63 paths`). dprint F26: Claude Code 2.1.316 parsed 1.65 MB of watchPaths correctly. `max_user_watches` here: 1,048,576.

## Code locations

`watchPathsHandler` (one `JSON.stringify` to stdout via `main`), `watchList`, `WATCH_LIMIT` (5000, `lint-file.mts` L109; the check is `list.size > WATCH_LIMIT`, so exactly 5000 files are watched and 5001 are not; output has no trailing newline; the over-limit note goes to stderr only).

## Approach

No change. On each Claude Code upgrade: a repo with about 4800 lintable paths, `claude -p --debug-file`, grep `provided N watchPaths` and `FileChanged: watching N paths`; the counts must match. If a cap appears, add a byte cap next to `WATCH_LIMIT` or switch to directory watchPaths (F15).

## Measured on 2.1.321

Claude Code 2.1.321, headless `claude -p --debug-file`, plugin-isolated. Method (F32 doc style): a renamed copy `universal-lint-f33` of the built `plugin/` (0.15.28, hook files unmodified) loaded via `--plugin-dir`; a `--settings` file with every installed plugin (25) under `enabledPlugins: false`, written before the first session. Raw logs are not committed.

| Run  | Repo                                                 | Debug-file lines                                                                         | SessionStart stdout                                                                                                                                     | stderr                                                                                                          |
| ---- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 4800 | 4800 tracked files `f0001.sh`..`f4800.sh`, committed | `provided 4800 watchPaths`, `FileChanged: watching 4800 paths` (counts match)            | 657,670 B: SessionStart stdout of a direct hook run (same binary, same cwd), reproduced byte-for-byte by the session's debug record of the hook payload | none (direct run)                                                                                               |
| 5001 | 5001 tracked files                                   | no `provided` / `watching` lines; hook result recorded as `success` (session debug file) | 0 B (direct run)                                                                                                                                        | one line (direct run): `universal-lint: watch list: more than 5000 files, FileChanged linting off for this cwd` |

- Isolation: the copy was the only plugin whose hooks registered. Both debug files show an `enabled=true` line for `universal-lint-f33`, 10 `enabled=false; will NOT register` lines (including universal-lint 0.15.0 and dprint), no `overrides installed version` line, and the copy's `lint-file.mjs` as the only `lint-file.mjs` hook script (the other hook paths are the user-settings hooks below and the disabled plugins' `hooks.json` reads). The user-settings hooks (`graphmind-session.sh`, `graphmind-prompt.sh`, `context-mode-cache-heal.mjs`) stayed active and are unrelated to watchPaths.
- Sessions replied `ok`; the `lint-file.mjs` hook finished with status 0 (211 ms in the 4800 debug file, 179 ms in the 5001 debug file).
- Byte caveat: 657,670 B / 4800 = about 137 B per path with the 126-character cwd prefix as measured. The earlier figures (about 180-200 B/path, 953 KB-1.1 MB at 4800) were taken on other repos; the per-path size presumably grows with path length (not measured here), so the quoted number holds for the stated prefix only. No byte cap was reached; a real path-heavy repo was not measured.
- One run per case: counts are deterministic for a static list.

## Verification

The grep above: watching count equals path count. Outcome on 2.1.321: 4800 = 4800; the over-limit case (5001) emits nothing on stdout and registers no watches. If a later re-check shows a count mismatch or a missing `watching` line, that is the cap signal and becomes an open question (byte cap vs directory watchPaths), not an in-place fix.

## Constraints

None now.

## Related

F15, F08, F12, F32, dprint F26.
