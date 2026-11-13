---
id: F26
title: Check whether Claude Code's hook stdout cap truncates huge watchPaths JSON
status: closed
priority: none
area: dprint/src/mcp/watch-paths.mts (main, WATCH_LIMIT)
---

## Status

Closed 2026-11-13: measurement record (not truncated on Claude Code 2.1.316), no code action; re-test after a Claude Code upgrade. `WATCH_LIMIT` now lives in `watch-list.mts`.

Earlier state: Open, no action expected. Analysis verdict: refuted for Claude Code 2.1.316 (the cap does not precede the hookSpecificOutput parse). Re-test only after a Claude Code upgrade or if FileChanged silently stops on large repos.

## Problem

`WATCH_LIMIT` counts files, not bytes: 5000 paths are ~761 KB, ~1.65 MB with ~220-char monorepo paths. Docs cap hook plain stdout/additionalContext/systemMessage/initialUserMessage at 10,000 chars (overflow persisted to a file, path + 2,000-char preview injected), and the binary carries strings for it (`tengu_hook_output_persisted`, `Hook output does not start with {, treating as plain text`). Unknown a priori whether the cap applies to a SessionStart command hook's JSON before the parse; if so a large list would lose FileChanged or inject truncated JSON into the session context.

## Evidence

Real headless sessions, plain `--debug`: 18,903 chars (11 runs), 761,031 chars (4951 paths) and 1,653,848 chars (4952 paths, ~220-char paths): JSON parsed OK, `provided N watchPaths`, `FileChanged: watching N paths`, 4954/4955 inotify watches; no `truncated`/`persist` line attributable to the dprint hook (the only `treating as plain text` lines belonged to other plugins' hooks).

## Code locations

`WATCH_LIMIT` (module const) and `main` in dprint/src/mcp/watch-paths.mts (single `JSON.stringify` to stdout).

## Approach

Nothing to do now. If a future Claude Code version caps/truncates: cap by serialized bytes (e.g. 512 KB) in addition to the count, or emit directories instead of files (see F24). Test FIRST on the new version: generate a 5k-file long-path repo (git init, dprint.json, ~220-char paths), run `claude -p --debug` and grep the debug log for `provided`, `FileChanged: watching`, `truncated`, `persist`, `treating as plain text`.

## Verification

The grep above on the new Claude Code version; compare the `watching N paths` count with the file count.

## Constraints

If a byte cap is ever added: edit src/ not plugin/*.mjs, build + test, fail open, TSDoc, version bump in both plugin.json and package.json.

## Related

F24 (directories as watchPaths would shrink the JSON), F25 (list cost).
