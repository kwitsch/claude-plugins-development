---
id: F07
title: Four $.env.get dispatches per owned call, also for invalid input
status: done
priority: low
area: jev-api/src/hooks/register.mts (onToolCall)
---

## Status

Done in jev-api 0.3.2: input validation runs before the env reads. Test: "an invalid call reads no env variable".

Earlier state: Open.

## Problem

`onToolCall` reads `TYPESAFE_API_KEY`, `TYPESAFE_BASE_URL`, `JEV_URL` and `TYPESAFE_DEFAULT_MODEL` (in parallel, `Promise.all`) on every owned call, before `parseInput`. Each `$.env.get` is an engine event dispatch through every plugin's `env.get` hooks. Invalid input pays all four although it never needs them; jevfort's `askJev` reads three of the same variables right before each `batch` call, so one jevfort decision costs 7 env dispatches.

## Evidence

Proven (harness counters): an owned call makes 4 `env.get`, 1 `http.fetch`, 1 `clock.after`, 1 cancel; an invalid `noul` (`instructions: ""`) still makes 4 `env.get`. Total plugin CPU per owned call with an instant in-memory fetch is 86-88 us median (F11), env reads included. Estimated: the cost of one `$.env.get` dispatch in the real engine is unmeasured (likely tens of microseconds, small next to the 50-4000 ms request).

## Code locations

- `onToolCall` (`Promise.all` over the four `$.env.get`, then `parseInput`)

## Approach

Move `parseInput` before the env reads (the error text order is unchanged: validation errors never depend on env). Caching the values per session is not proposed: a hook above may answer `env.get` differently over time, and the gain is unmeasured.

## Verification

Kit test: an invalid call with an `env.get` stub that counts reads ends with 0 reads; all existing error-message tests stay green.

## Constraints

Literal names in `$.env.get` (engine static check). The refused-env-read test ("a refused env read still answers the tool") must still answer.

## Related

F11.
