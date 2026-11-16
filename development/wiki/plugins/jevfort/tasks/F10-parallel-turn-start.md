---
id: F10
title: Classify and step 0 in parallel or as one batch
status: closed
priority: none
area: jevfort/src/hooks/register.mts (onPromptSubmit, onTurnStep)
---

## Status

Closed 2026-11-14: measurement record, decided not to do (no gain).

## Problem

Question answered: every turn sends two Jev requests one after another before its first token (the classifier in `prompt.submit`, the step-0 batch in `turn.step`). Would starting the step-0 request from `prompt.submit` alongside the classifier, or sending all seven questions as one batch, shorten the turn start?

## Evidence

Proven, real System One through jev-api 0.3.2's built hook, jevfort 0.10.1's batch inputs (20 skills), 5 runs each: sequential 1584 ms (p90 2088), both at once 1496 ms (p90 1561), one merged batch of 7 questions 1514 ms (p90 1537). The endpoint answers concurrent requests one after another and latency follows the request body, so neither variant saves more than ~6%, while both would add a cross-hook request (raised in `prompt.submit`, awaited in `turn.step`) and a step-0 decision made before the transcript has the prompt.

## Code locations

- `onPromptSubmit` (classifier `askJev`), `onTurnStep` step 0 (`askJev` with `next_action`, `effort`, `mechanical`, `single_action`).

## Approach

None. Shrinking the requests (F01, F02) is what shortens the turn start.

## Verification

None needed.

## Constraints

None.

## Related

F01, F02, jev-api F13 (batch vs parallel singles).
