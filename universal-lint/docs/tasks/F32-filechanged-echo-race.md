---
id: F32
title: Measure how often the FileChanged echo of Claude's own write beats the digest
status: done
priority: low
area: universal-lint/src/hooks/lint-file.mts (fileChangedHandler, recordWritten, recordWrittenFor, main)
---

# F32 Measure the FileChanged echo race

## Status

Closed docs-only in 0.15.28. Measured on 0.15.27: an instrumented scratch copy of the built hook (`plugin/` copied, renamed `universal-lint-f32`, log statements only, never shipped; JSONL event log in the session scratchpad under `f32/logs/`, ephemeral, not committed), 3 headless `claude -p` sessions, Claude Code 2.1.321, one machine (WSL2), 61 Write/Edit calls (2 with a stdin payload over 200 KB, max 305100 bytes). Isolation: every installed plugin disabled through `--settings` (`enabledPlugins` all `false`), the copy was the only plugin loaded; the user-settings hooks (`graphmind-search.sh`, `graphmind-prompt.sh`, `graphmind-session.sh`, `context-mode-cache-heal.mjs`) stayed active, none writing to the scratch repo or a digest dir; the installed plugin's `written/` dir was unchanged in every session.

1. Echoes: 55 FileChanged echoes of 61 writes; 6 writes without echo (files created after SessionStart are not watched; headless exit), 0 non-echo FileChanged, 0 out of scope.
2. Digest compare on echoes: 55 hits, 0 misses without a digest, 0 stale-digest misses; 0 digest write errors. Duplicate lints: 0 (misses by outcome: 0 linted, 0 git skip, 0 no slot).
3. Race margin (FileChanged digest read minus digest landed, ms, min/p50/p90/max; negative = read first): 592/600/610/2083; >200 KB Edits 595/595/609/609. FileChanged process start minus digest landed: 585/592/600/2072. PostToolUse window (process start to digest): 7/10/11/12; >200 KB 11/11/11/11.
4. Below the threshold fixed in advance (misses >= 5 % of echoes or >= 3 absolute), so no fix. Small sample (one machine, about 60 writes); reopen if a session shows repeated duplicate FileChanged findings after Write/Edit.

## Problem

Claude Code reports Claude's own Write/Edit of a watched file as FileChanged. Normally the digest PostToolUse recorded matches and the echo is skipped (about 40-54 ms). If the echo arrives before `recordWritten` lands (documented race) or no digest was written (F05), a full duplicate lint runs (about 1 s CPU for TS/md, duplicate findings). How often the race happens is unknown; transcripts do not record FileChanged runs.

## Evidence

Live sessions: echo FileChanged arrived about 0.6 s (one run) and about 1.5 s (another) after PostToolUse; digest matched, skipped in 43-54 ms; 4 extra spawns for 6 edits. The big.md Edit without a digest (F05) produced a whole-file lint 5.3 s later.

## Code locations

`fileChangedHandler` (digest compare), `recordWritten`/`recordWrittenFor` (written before the lint starts), `main`.

## Approach

One instrumented session series (a scratch build that appends event, path, timestamps and digest hit/miss to a JSONL file in the session scratchpad; the copy's CLAUDE_PLUGIN_DATA held only its own digests; never ship the logging), many small and large Write/Edits on watched files. Report the share of echoes that miss the digest. Only if it is material, consider fixes (e.g. recording the digest earlier, or a short re-check in FileChanged).

## Verification

Log analysis: count of echo events, digest hits, misses and duplicate lints.

## Constraints

No telemetry in the shipped plugin.

## Related

F05, F26, F01.
