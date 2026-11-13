---
id: F20
title: jevfort's 4 s budget and jev-api's 4 s timeout race each other
status: closed
priority: none
area: jevfort/src/hooks/jev.mts (JEV_API_TIMEOUT_S, TIMEOUT_MS), jev-api/src/hooks/register.mts (ask)
---

## Status

Closed without code (measurement record, re-run 2026-11-13): harmless.

## Problem

Since 0.9.1 jevfort passes `timeout: 4` with its own 4000 ms budget (likewise 12 / 12,000 for a compaction). Both clocks run out at about the same time, so the question was which one decides and whether a late answer is lost or misreported.

## Evidence

Proven (`chain.mjs`, stub): answer after 4.5 s: jevfort reports `timeout after 4000ms` at 4000-4001 ms and falls back; jev-api's own timer starts later (after the dispatch, its env reads and, while a registration is pending, up to 1 s of `within`, F16), so its answer comes after jevfort gave up and is ignored. Answer after 3.9 s: both succeed (3904 ms). Haiku path: jev-api's 14 s fires before jevfort's 15 s, so jev-api's `deny` reaches jevfort as the error. In every case the HTTP request runs on (F09).

## Code locations

- jevfort `askJev`; jev-api `ask`

## Approach

None: jevfort's budget always decides on the System One paths; jev-api's timeout only frees its hook a moment later instead of 20 s later, which was the point of F01.

## Verification

None needed.

## Constraints

None.

## Related

F01, F09, F16, F19.
