---
id: F12
title: Memory and the 15 s cache tick
status: closed
priority: none
area: jevfort/src/hooks/register.mts (turns, firstTurns, ownCalls, cacheTick), jevfort/src/hooks/log.mts (recent)
---

## Status

Closed 2026-11-14: measurement record, no code action.

## Problem

Question answered: does jevfort's module state grow over a long session, and what does the 15 s cache tick cost while idle?

## Evidence

Proven (harness, one module instance, `--expose-gc`, 300 + 2000 + 2000 turns of 4 main-loop steps and one subagent turn each): heap 15.9 / 80.7 / 145.5 MB while running at full speed, 6.9 MB after a 5 s idle wait. The growth is the uncancelled budget sleeps of `askJev` (F08), not state: `turns` entries are deleted at `turn.complete`, `firstTurns` gains one small entry per subagent until `session.start`/`session.end`, `ownCalls` holds only Jev-taken calls until their outcome, the `/jev` buffer keeps 50 entries, the store log is capped at 1000. `cacheTick` returns without an engine call while no response was seen and nothing is drawn; otherwise one `clock.now` per tick, plus `session.usage` only once the cache is cold.

## Code locations

- `turns`, `firstTurns`, `ownCalls`, `forgetConversation` (register.mts); `remember`/`recent` (log.mts); `cacheTick`.

## Approach

None (the timer retention is F08).

## Verification

None needed.

## Constraints

None.

## Related

F08.
