---
id: F13
title: Batch vs single requests, parallel calls
status: closed
priority: none
area: jev-api/src/hooks/register.mts (ask, batch tool)
---

## Status

Closed 2026-11-13 (measurement record): one `batch` request is the fastest shape; the plugin adds no serialization.

## Problem

`batch` sends all questions in one request; the alternative would be one request per question, sequential or parallel, or splitting a large batch into parallel chunks.

## Evidence

Proven (real System One from `JEV_URL`, bare fetch):

| Shape                                            | ms     |
| ------------------------------------------------ | ------ |
| 1 batch of 3 (noul, choice, score), median of 10 | 130.0  |
| 3 single requests, sequential                    | 201.5  |
| 3 single requests, parallel                      | 172.6  |
| 1 batch of 10 short scores, median of 3          | 734.7  |
| 10 single short scores, parallel                 | 1102.0 |
| 10 single compaction-sized scores, parallel      | 1794.9 |

The server handles parallel requests no faster than one batch, so splitting does not help (see F01 for the linear growth). Proven (harness, local stub with 50 ms delay): parallel owned calls are not serialized by the plugin: 1 / 8 / 32 parallel `batch` calls took 50.7 / 57.9 / 71.3 ms through the hook against 51.0 / 53.9 / 76.5 ms bare, with all 32 requests in flight at once on the stub. There is no in-flight limit in the plugin; jevfort issues at most a few concurrent calls.

## Code locations

- `ask`, `SPECS.batch`

## Approach

None.

## Verification

None.

## Constraints

jevfort depends on `batch` (name, input, answer order).

## Related

F01, F11.
