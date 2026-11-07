---
id: F32
title: Measure how often the FileChanged echo of Claude's own write beats the digest
status: measurement-only
priority: low
area: universal-lint/src/hooks/lint-file.mts (fileChangedHandler, recordWritten, recordWrittenFor, main)
---

# F32 Measure the FileChanged echo race

## Status

Measurement-only, open. Static missed item (measurement gap), partly answered by the live sessions of the watch-filechanged and real-sessions dimensions.

## Problem

Claude Code reports Claude's own Write/Edit of a watched file as FileChanged. Normally the digest PostToolUse recorded matches and the echo is skipped (about 40-54 ms). If the echo arrives before `recordWritten` lands (documented race) or no digest was written (F05), a full duplicate lint runs (about 1 s CPU for TS/md, duplicate findings). How often the race happens is unknown; transcripts do not record FileChanged runs.

## Evidence

Live sessions: echo FileChanged arrived about 0.6 s (one run) and about 1.5 s (another) after PostToolUse; digest matched, skipped in 43-54 ms; 4 extra spawns for 6 edits. The big.md Edit without a digest (F05) produced a whole-file lint 5.3 s later.

## Code locations

`fileChangedHandler` (digest compare), `recordWritten`/`recordWrittenFor` (written before the lint starts), `main`.

## Approach

One instrumented session series (a scratch build that appends event, path, timestamps and digest hit/miss to a log under CLAUDE_PLUGIN_DATA; never ship the logging), many small and large Write/Edits on watched files. Report the share of echoes that miss the digest. Only if it is material, consider fixes (e.g. recording the digest earlier, or a short re-check in FileChanged).

## Verification

Log analysis: count of echo events, digest hits, misses and duplicate lints.

## Constraints

No telemetry in the shipped plugin.

## Related

F05, F26, F01.
