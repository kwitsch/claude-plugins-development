---
id: F14
title: The agent-type choice waits ~1.15 s before every Agent dispatch and switched no type in 103 real calls
status: partial
priority: medium
area: jevfort/src/hooks/register.mts (onAgentCall, onAgentOffer), jevfort/src/hooks/agents.mts (GENERAL, SWITCH_AT)
---

## Status

Partial: approach 1 shipped in 0.12.0 (an Agent call with a specific type, `!GENERAL.has(claudeType)`, makes no Jev request; the 9% that could never switch no longer wait). Approaches 2 and 3 (smaller request, lower `SWITCH_AT` or drop the feature) stay open and need a decision; the `agent` decision log entries mentioned below were removed in 0.12.0 with the log.

Earlier state: open. Found in the performance analysis after the worklist ([../EVALUATION-2026-11-14-2.md](../EVALUATION-2026-11-14-2.md)), plugin 0.11.0, from the real decision log of the installed 0.10.1 (the code is unchanged since the port, `ca6b468`). F01's decision left the agent-type choice as is (30 synthetic types 1.04 s, below the budget); the real log adds its benefit side.

## Problem

`onAgentCall` (`tool.call` with matcher `{ tool: "Agent" }`) asks Jev, before `next(e)`, which offered agent type fits the task: every type `onAgentOffer` saw (up to `MAX_CHOICE_OPTIONS`), each with a description clipped to 200 characters, whenever at least two types are offered and the call is not a `fork`. The answer changes the call only when Claude's type is general (`GENERAL`: `""`, `general-purpose`, `claude`), Jev picks a specialised type and its probability reaches `SWITCH_AT` 0.85; otherwise it is only logged (`agent` entry with `agree`). The ask is awaited on the main loop's critical path: the subagent starts after it.

- Real log: 103 calls, median 1152 ms (p90 1677, max 4243; 4 calls took 3 s or more), 133 s of waiting in all, and 0 switches. Jev picked a specialised type in 59 of the 94 calls with a general type, with a median p of 0.44 and a maximum of 0.82 (p >= 0.8: 1 call, >= 0.7: 3, >= 0.6: 10).
- 9 of the 103 calls (9%) carried a specific type from Claude, which can never be switched: 16 s spent on a log line.
- The cost grows with the offered types (each ~200 bytes): harness bodies 6.2 KB at 30 types, 12.2 KB at 60, 24.2 KB at 120; with System One's ~0.16 ms per byte, ~2 s at 60 types and the 4 s budget at about 120 (estimated), where a timeout also trips `jevPause` for every Jev feature (as F01 did for the classifier).

## Evidence

Proven: the user's real decision log (1000 entries over 30 hours, counts and latencies only, `agentstats.py`/`agentstats2.py` in the evaluation); harness bodies by offered types (`bench4.mjs`); the analysis's real System One figures (5 / 15 / 30 types: 237 / 572 / 1040 ms). Estimated: the latency at 60 and 120 types; the number of types the engine offers in the user's sessions (the 1152 ms median fits ~30; enabled plugins and user settings hold 7 agent definitions besides the built-in and project ones).

## Code locations

- `onAgentCall` (register.mts): the `offered.size < 2 || claudeType === "fork"` guard, the `criteria` loop (`clip(description, 200)`), `askJev`, `canSwitch`.
- `onAgentOffer` (register.mts): fills `offered`.
- `GENERAL`, `SWITCH_AT` (agents.mts).

## Approach

Cheapest first:

1. Ask only when a switch is possible (`GENERAL.has(claudeType)`); a call with a specific type goes `next(e)` at once. If the agreement figure for specific types is still wanted, raise the ask in-frame before `next(e)` and await it after `next(e)` returns (the hook frame is still running, so the storage rule holds), off the critical path like `measureSteps`.
2. Shrink the request: descriptions clipped to ~100 characters (about half the body), or only the first sentence.
3. Revisit the feature: with 0 switches in 103 real calls and a top p of 0.82, it currently costs latency only. Options: lower `SWITCH_AT` (0.8 would have switched 1 call in 103, 0.7 three), make the choice opt-in, or drop it. This needs a decision (user, or a decision agent with its reasoning written here).

Recommendation: 1 now (no behaviour change: a specific type was never switched); 3 as a decision.

## Verification

Shipped in 0.12.0: `tests/phase3.test.mts` "An Agent call with a specific type makes no Jev request" (subagent_type `Plan`, two offered types, no batch call, dispatched unchanged) fails on the previous build (one batch call) and passes now; the older switch test now expects 3 asks for its 4 calls. Not measured live: the saving is the skipped ask (real median 1152 ms for 9 of 103 calls).

Planned verification:

- Kit test (`tests/phase3.test.mts`): an Agent call with `subagent_type: "Explore"` and several offered types makes no batch call and dispatches unchanged; fails on 0.11.0 (one batch call).
- In a new dated evaluation: the share of Agent calls that ask, and the median ask latency from fresh log entries.

## Constraints

Every Jev failure falls back to Claude Code's own behaviour; jev-api's `batch` shape stays. `onAgentOffer` must keep honouring `isOffered: false` (a withheld type is never a switch target).

## Related

F01 (the decision that left this choice as is), F02 (request size drives latency), F13 (the other option list that grows with the installation).
