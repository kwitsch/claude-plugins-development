---
id: F05
title: Read hook stdin robustly; payloads over about 190 KB are silently not linted
status: done
priority: medium
area: universal-lint/src/hooks/lint-file.mts (main, recordWrittenFor, recordWritten, fileChangedHandler), universal-lint/tests/core.test.mts, universal-lint/.claude/rules/hook-design.md, universal-lint/.claude/rules/tests.md, universal-lint/scripts/perf.mts
---

# F05 Read hook stdin robustly

## Status

Done in 0.15.4. `main` is now `async` and reads the payload with `await json(process.stdin)` (`node:stream/consumers`) to EOF, and the module ends with `if (isMainModule()) void main();`; fail open, the findings contract (stderr + exit 2), the event dispatch and `hooks.json` are unchanged. Root cause (probed during design): the hook's own `import process from "node:process"` evaluates the `process.stdin` getter, which makes fd 0 a non-blocking libuv pipe handle, so the synchronous read threw EAGAIN for any late or larger-than-pipe-buffer writer; this is why even `cat p512.json | lint-file.mjs` failed while a file redirect worked (a file never returns EAGAIN). Tests (`tests/core.test.mts`, two): a 512 KB Edit payload (padding in `tool_response.originalFile`) and a 512 KB Write payload (padding in `tool_input.content`), each written 100 ms late through an async `spawn` stdin pipe (`runLate`), are linted (the recording shellcheck stub ran) and record their digest under `CLAUDE_PLUGIN_DATA/written`; both failed against the 0.15.3 build. Measured with `node universal-lint/scripts/perf.mts 5` (file as stdin), medians in ms, before (0.15.3) -> after (0.15.4), real PATH / no /mnt: `empty payload {}` 44 -> 48 / 45 -> 44; `.sh Write` 146 -> 148 / 45 -> 49 (the async stream read costs about one event-loop turn per event; full run in `.claude/rules/hook-design.md` "Measured cost"). The live `claude -p` big.md check from Verification was not re-run (the vitest tests cover the mechanism).

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

Shipped: `main` is `async` and reads `(await json(process.stdin)) as PostToolUseHookInput`; the bottom call is `if (isMainModule()) void main();` (no top-level await, so importers never see an async module, and `main` cannot reject because its whole body is in the fail-open `try/catch`). `json()` was taken over the sketched `for await (const c of process.stdin) s += c;` because it decodes UTF-8 across chunk boundaries and parses in one stdlib call. Not taken: the synchronous `readSync` loop on fd 0 with `Atomics.wait` on EAGAIN: it works and keeps `main` synchronous, but is about 10-12 lines of hand-written I/O (buffer growth, EAGAIN versus other error codes, EOF, decode) plus up to 5 ms of polling per wait, replacing one stdlib call. Not taken: dropping the `node:process` import so fd 0 stays blocking: a one-line deletion that rests on an invisible invariant (any later `node:process` import or `process.stdin` access brings the bug back) and still fails when the parent hands over an already non-blocking file description; the async read is immune to both. The tests.md note was reworded to the post-fix truth: any pipe or a file works as stdin; drive concurrent hook runs with async `spawn`.

## Verification

Vitest: spawn the built hook with `spawn` and stdio pipe, write a 512 KB PostToolUse Edit payload (padding in `tool_response.originalFile`) after a 100 ms delay; assert the recording stub ran and the digest file exists under `CLAUDE_PLUGIN_DATA/written`. Same for a 512 KB Write. Real session: PostToolUse on big.md takes more than about 0.5 s and the FileChanged echo returns quickly.

## Constraints

Shared by every event (`main`); fail open; zero-dependency; findings contract (stderr + exit 2) unchanged. Version bump.

## Related

F25 (size bound for huge files), F32 (echo race), F01 (harness caveat), F27.
