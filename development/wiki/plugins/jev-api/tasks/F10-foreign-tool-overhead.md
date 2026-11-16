---
id: F10
title: Foreign-tool overhead of the matcher-less tool.call hook
status: closed
priority: none
area: jev-api/src/hooks/register.mts (onToolCall)
---

## Status

Closed 2026-11-13 (measurement record): the plugin's own share is about 0.1 us per foreign tool call; nothing worth changing.

## Problem

`onToolCall` has no matcher, so it sits in the `tool.call` chain of every tool call of the session (Read, Bash, Edit, MCP tools, ...). For a foreign tool it does `names.get(e.tool)` (a `Map` of at most 8 entries) and `return next(e)` from an `async` function.

## Evidence

Proven (in-process harness, built `plugin/hooks/register.mjs`, fake `$`, `next` resolving a constant; 400 samples of 1000 sequential awaited calls after 50,000 warm-up calls):

| Variant                            | Median us/call | p90 us/call | Microtask ticks to settle | Heap bytes/call (no GC) |
| ---------------------------------- | -------------- | ----------- | ------------------------- | ----------------------- |
| `next(e)` alone                    | 0.106          | 0.159       | 1                         | 38.7                    |
| empty `async` pass-through hook    | 0.136          | 0.192       | 3                         | 78.1                    |
| jev-api `onToolCall`, foreign tool | 0.208          | 0.265       | 3                         | 59.4                    |

Engine ops touched for a foreign tool: 0 (`env.get`, `tool.register`, `clock.after`, `http.fetch` all 0; registration is not triggered). Heap after 1,000,000 foreign calls: 30.71 -> 30.68 MB (no growth). Not measured: the Claude Code engine's own cost of dispatching one more hook in the chain, which dominates and cannot be avoided.

## Code locations

- `onToolCall` (first two lines), `register` (`names` map)

## Approach

None. A matcher cannot replace the check (the names are dynamic: the engine may return `mcp__<other>__<type>`; one matcher-less hook per event is an engine constraint, `../CLAUDE.md`). Dropping `async` to save the two extra ticks (~0.1 us) is not worth the risk of a sync throw escaping.

## Verification

Existing test "a call to another tool reaches the next hook unchanged".

## Constraints

Foreign tools must reach `next(e)` unchanged.

## Related

F11.
