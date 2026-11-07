---
id: F05
title: Read hook stdin robustly; payloads over about 190 KB are silently not linted
status: open
priority: medium
area: universal-lint/src/hooks/lint-file.mts (main, recordWrittenFor, recordWritten, fileChangedHandler)
---

# F05 Read hook stdin robustly

## Status

Open. watch-filechanged finding (confirmed, medium) plus a verifier missed item (Write is affected too, and plain shell pipes).

## Problem

`main` parses `JSON.parse(readFileSync(0, "utf8"))`. When stdin is non-blocking and the writer has not delivered everything yet, Node throws EAGAIN: payloads above the pipe/socket buffer (about 128-192 KB) or a late writer. The fail-open catch swallows it silently: no lint, no digest. Edit payloads carry the whole original file (`tool_response.originalFile`), Write payloads the whole content (`tool_input.content`), so any Write/Edit of a file over about 190 KB loses its PostToolUse lint. With no digest recorded, the FileChanged echo then lints the whole file (no edit-range gate), defeating the self-write dedupe.

## Evidence

- Real session (`claude -p`, 0.14.0): Edit of big.md (527 KB) → PostToolUse payload 536,686 bytes; debug log `PostToolUse:Edit [... lint-file.mjs] finished with status 0 (44ms)`; no digest file under `~/.claude/plugins/data/universal-lint-kwitsch-plugins/written`; the FileChanged echo 5.3 s later linted the whole file.
- Node-spawned stdin pipe with a recording markdownlint-cli2 stub: 16/64/128 KB linted with digest; 192 and 256 KB exit 0 in about 45 ms, no lint, no digest; a 1 KB payload written 50 ms late: no lint.
- `cat p512.json | lint-file.mjs`: no lint, no digest. Same payload from a file redirect: linted.
- Small-payload bursts in real sessions: no EAGAIN (stdin delay at most 9 ms over 50 events).

## Code locations

- `main` (`readFileSync(0, "utf8")` inside the fail-open try; dispatch on `hook_event_name`)
- `recordWrittenFor` / `recordWritten` (never reached on EAGAIN), `fileChangedHandler` (digest miss → whole-file lint)

## Approach

Replace the read with one that tolerates EAGAIN. Simplest: make `main` async and read `for await (const c of process.stdin) s += c;` (the top-level `if (isMainModule()) main()` stays). Synchronous alternative: a `readSync` loop on fd 0 that waits about 5 ms with `Atomics.wait` on EAGAIN and stops at EOF. Keep fail-open on JSON parse errors and the exit-code contract. Add the harness note to tests.md: drive concurrent hook runs with stdin from a file or a blocking pipe.

## Verification

Vitest: spawn the built hook with `spawn` and stdio pipe, write a 512 KB PostToolUse Edit payload (padding in `tool_response.originalFile`) after a 100 ms delay; assert the recording stub ran and the digest file exists under `CLAUDE_PLUGIN_DATA/written`. Same for a 512 KB Write. Real session: PostToolUse on big.md takes more than about 0.5 s and the FileChanged echo returns quickly.

## Constraints

Shared by every event (`main`); fail open; zero-dependency; findings contract (stderr + exit 2) unchanged. Version bump.

## Related

F25 (size bound for huge files), F32 (echo race), F01 (harness caveat), F27.
