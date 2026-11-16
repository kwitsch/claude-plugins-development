---
paths:
  - "src/hooks/cache.ts"
  - "src/hooks/compact.ts"
  - "src/hooks/register.ts"
  - "tests/cache.test.ts"
  - "tests/phase3.test.ts"
---

# Cache countdown, auto-compact and compaction

None needs jev-api: the work runs before the readiness guard of
`turn.step`/`turn.complete`, and `session.compact` has no guard except around the Jev ranking (hook wiring:
`register-hooks.md`). `cache.ts` is pure (TTL detection, minutes, label, colour); `compact.ts` holds the Haiku
transcript and prompt.

## Countdown

- `cacheWatch` wraps `next` in `turn.step`: a main-loop response with `usage` (the step always runs on the chat's own
  model) sets `cacheExpires = now + TTL`, in a try/catch (a cosmetic feature never fails the step).
- TTL is the assumed 1 hour: Claude Code 2.1.322 reports a step's usage without `cache_creation`, so `cacheTtlOf`
  stays dormant and a 5-minute cache (API key, Bedrock/Vertex/Foundry, a subscription past its limit) is not detected:
  its countdown and auto-compact wait run 55 minutes long. Do not infer 5m from a cold re-write: a prefix change on a
  1-hour account looks the same and would compact a warm chat.
- A 15 s `$.clock.every` (started in `session.start`, cancelled and restarted there; a reload re-raises
  `session.start`) runs `cacheTick`, which redraws the band when the minute changed.
- `resetCache` resets the countdown from `session.start` and `session.end` (`session.end` also resets the first-turn estimates, the band and `autoOff`).

## Auto-compact on a cold cache

- With `autoCompactPercent > 0`, `cacheTick` runs `$.command.run({ command: "compact" })` once when the cache is cold,
  no main-loop turn runs (`turnRunning`), `$.session.usage().context.percent` is at or above the option and
  `coldCompacted` is unset (read again after the await: ticks overlap). The engine queues it until the session is idle
  and keeps the promise pending until it ran; a refusal is not retried. The next response resets `coldCompacted`.
- `turnRunning` is set at the first `turn.step` and cleared in `turn.complete`; the prompt-submit phase before it is not
  covered, so a cold tick there queues `/compact` behind the user's prompt.
- It does not consult Claude Code's own Auto-compact setting (`plugin/README.md` says so). Author decision of the
  0.7.0 review (2026-11-12), like the assumed 1-hour TTL, the uncovered prompt-submit phase and the Haiku path's
  trade-off below: do not re-flag them.
- Not verified live: `$.command.run` from a timer callback (read from the 2.1.322 binary: queued as a plugin-origin
  prompt entry); the kit tests cover it.

## Context-fill compaction

- `contextCompact` asks the task-end question (`taskEndQuestion`) as its own request.
- Its `compactQueued` is also cleared when its `$.command.run("compact")` resolves (engine fact: root
  `claude-code-hook-facts.md`), so a later full turn end compacts again even when `session.compact` is bypassed.

## `session.compact`

- Always registered, subagents pass. Jev ranking first (`withJevRanking`, only with jev-api and the `compaction`
  option), then with `haikuCompact` Haiku's summary as the returned `messages` (`precompute` is skipped with
  `{ skip }`; a failure, a summary of 200 characters or fewer or one that used all `COMPACT_MAX_TOKENS` (cut off) goes
  `next(...)`).
- `cacheExpires = 0` only once a compaction stands (the Haiku return or a `next(...)` result without `skip`, never for
  `precompute`).
- Trade-off of the Haiku path (read from the 2.1.322 binary): answering `{ messages }` without `next` skips core's
  compaction step, so classic PreCompact hooks do not run (a blocking one is ignored), PostCompact gets an empty
  summary, recently read files, the plan file and invoked skills are not re-attached, and a lower plugin's
  `session.compact` hook (inline-headroom's dedup reset) sees nothing when jevfort is the outer plugin.

## Known limit: `session.compact` is bypassed (Claude Code 2.1.325)

The built-in `cc-plugin-sec-default` passes `session.compact` on past every user-tier hook (debug log:
`jevfort: session.compact bypassed by cc-plugin-sec-default (tier user); beneath runs`, and
`its session.compact hook was skipped`), as for the events in `register-hooks.md` (for `tool.check` only a
re-dispatch notice appears, the verdict stays allow: `development/wiki/plugins/inline-headroom/claude-code-verification.md`). So the Jev ranking, the Haiku compaction and the
`cacheExpires = 0` reset do not run; core compacts on its own. Seen with a manual `/compact` in `claude -p`; an
interactive session and an auto-compaction were not tried. Nothing in this plugin can get past a prepend-tier hook; the
code and its tests stay as they are (the kit runs the hook).

## Known limit: a hook above refusing a core read

`turn.step` calls `$.session.messages`, `$.session.cwd` and the summary `$.model.complete` before `next`. A hook above
jevfort that refuses one of them skips jevfort's whole `turn.step` hook for that step, including the `cacheWatch` wrap:
the countdown keeps the previous response's expiry and auto-compact may run up to the cache lifetime early. Not guarded
(it needs another plugin refusing core reads); the step itself is unaffected.
