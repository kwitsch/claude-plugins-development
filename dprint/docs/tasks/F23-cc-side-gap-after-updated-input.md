---
id: F23
title: Re-verify the apparent Claude-side gap after format_pre updatedInput
status: closed
priority: none
area: n/a (Claude Code behaviour; dprint/src/mcp/format.mts formatPre returns the updatedInput)
---

# F23 Re-verify the apparent Claude-side gap after format_pre updatedInput

## Status

Closed 2026-11-13: measurement record (gap refuted), no code action.

Open, no action expected. Analysis verdict: refuted (clock artefact). Kept so a future session does not re-investigate it from the smoke log alone.

## Problem

In the first smoke session the Edit of a 2976-line `big.ts` showed ~1.3 s between format_pre's `updatedInput` answer and the PostToolUse `file_written` request, vs 34-52 ms for other formatted calls and 45 ms for the same Edit when format_pre returned `{}`. Hypothesis: something Claude-side scales with file size only when `updatedInput` is present.

## Evidence

- The same call showed `Date.now()` diff 2168 ms vs `hrtime` diff 1308 ms: WSL2 wall-clock jumps (+860 ms, +1246 ms) happened inside the window. No debug lines between 18:42:51.800 and 18:42:55.267.
- Re-measurement with monotonic proxy timestamps (edits-A/B): big.ts with updatedInput n=10: 23.5-44.4 ms (median ~26.7); bigfmt.ts (clean, `{}`) n=10: 20.3-35.1 ms; mid.ts (331 lines, updatedInput) n=20: 19.6-38 ms. All <= 100 ms; the 1.3 s does not reproduce.

## Code locations

None in this repo. formatPre in dprint/src/mcp/format.mts only produces `hookSpecificOutput.updatedInput`; the gap would be inside Claude Code.

## Approach

No fix. If it ever reappears: measure gap = (file_written request hrtime) - (format_pre response hrtime) on the stdio proxy, never from wall-clock debug timestamps; repeat >= 10x on a >= 3000-line dirty file; only if the monotonic gap is reproducibly > 100 ms is it worth a Claude Code bug report (include per-run numbers).

## Verification

Monotonic-clock repro as above. No test to add.

## Constraints

Use hrtime/monotonic time only for latency attribution on WSL2.

## Related

F22 (baseline and timing method), F21 (shares the format_pre -> file_written ordering).
