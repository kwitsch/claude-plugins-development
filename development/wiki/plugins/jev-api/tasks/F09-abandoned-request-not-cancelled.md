---
id: F09
title: A timed-out or abandoned request keeps running on the server
status: done
priority: low
area: jev-api/src/hooks/register.mts (ask), jev-api/CLAUDE.md
---

## Status

Done in jev-api 0.3.2 as documentation: `CLAUDE.md` states that a timed-out or abandoned request is not cancelled (engine limit) and that callers keep jev-api's `timeout` at or below their budget; jevfort now does (F01).

Earlier state: Docs-only: no code change possible in jev-api today. Remaining action: one sentence in `../CLAUDE.md`.

## Problem

When `ask` answers `timeout after <ms>` or `the call was abandoned`, the `$.http.fetch` request is left running (`request.catch(() => undefined)` only silences its late rejection). The engine's `HttpInit` has `method`, `headers`, `body`, `auth` and no `signal`, so the plugin cannot cancel it. The server keeps computing the answer and the engine keeps the connection until the answer or its own 30 s fetch cap.

## Evidence

Proven (harness, local stub answering after 300 ms): 50 calls with `timeout: 0.05` all answered `noul: timeout after 50ms`, 50 aborted calls all answered `noul: the call was abandoned`; right after both, 100 requests were still open on the stub; all closed 400 ms later. Proven from the engine typings (`HttpInit` in the claude-mods `claude-code.d.ts`): no abort option.

## Code locations

- `ask` (`request.catch`, the `stop` race)

## Approach

Document in `../CLAUDE.md` that a timed-out or abandoned request is not cancelled (engine limit) and that callers should keep jev-api's `timeout` at or below their own budget (jevfort today: 5 s timeout vs 4 s budget, F01). Revisit if the engine adds a `signal` to `HttpInit`.

## Verification

None (docs). If the engine gains `signal`: a test that the stub sees the request aborted on timeout.

## Constraints

None.

## Related

F01, F05.
