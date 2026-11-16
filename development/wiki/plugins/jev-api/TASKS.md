# jev-api performance tasks

Source: performance analysis of jev-api 0.3.1 on 2026-11-13, numbers in [EVALUATION-2026-11-13.md](evaluations/EVALUATION-2026-11-13.md). One document per finding in `tasks/`; read it before working on the task. Proven = measured in the harness or shown by the code; estimated = a derived figure (token counts, engine behaviour not run), marked as such in each task.

Source: performance analysis of jev-api 0.5.0 on 2026-11-15, numbers in [EVALUATION-2026-11-15.md](evaluations/EVALUATION-2026-11-15.md).

Entry format and sections: `.claude/rules/plugin-docs-tasks.md`; `wiki-check.ts` checks them against the `tasks/` frontmatter.

## Remaining

- [ ] [F23](tasks/F23-server-rss-grows-young-generation.md) `open` low: The transport server's RSS grows from 49 MB to over 200 MB while its JS heap stays at 12 MB
- [ ] [F24](tasks/F24-timeout-not-a-bound.md) `partial` low: A call's timeout does not bound it: one-off waits for registration, store, connect and config come before the request

## Done

- [x] [F01](tasks/F01-jevfort-budget-below-batch-latency.md) `done` high: jevfort's 4 s askJev budget is below real System One latency for large batches
- [x] [F02](tasks/F02-failed-registration-never-retried.md) `done` medium: A failed tool registration is never retried in the session
- [x] [F03](tasks/F03-owned-call-awaits-registration.md) `done` medium: A hanging $.tool.register blocks session.start and every owned tool call
- [x] [F04](tasks/F04-haiku-maxtokens-many-options.md) `done` medium: Haiku fallback maxTokens is too small for a choice with many options
- [x] [F05](tasks/F05-pre-aborted-call-sends-request.md) `done` low: An already abandoned call still sends its System One request
- [x] [F06](tasks/F06-abort-listener-not-removed.md) `done` low: Abort listeners stay on next.signal after the call settles
- [x] [F07](tasks/F07-env-reads-before-validation.md) `done` low: Four $.env.get dispatches per owned call, also for invalid input
- [x] [F09](tasks/F09-abandoned-request-not-cancelled.md) `done` low: A timed-out or abandoned request keeps running on the server
- [x] [F16](tasks/F16-hung-registration-stays-memoized.md) `done` medium: A hung registration stays memoized - every owned call waits 1 s, every session.start 5 s, no retry
- [x] [F17](tasks/F17-registration-retry-without-backoff.md) `done` low: A permanently failing registration is retried on every owned call, with a log line each time
- [x] [F21](tasks/F21-oversized-state-sent-blindly.md) `done` medium: A state too large for System One is sent anyway: it fails with a 400, or runs into the timeout and keeps burning server time
- [x] [F22](tasks/F22-http-through-mcp-server.md) `done` medium: The System One request cannot be cancelled and has no timeout option: it goes through a bundled MCP server

## Closed without code

- [x] [F08](tasks/F08-haiku-prompt-repeats-criteria.md) `closed` low: Haiku prompt repeats identical criteria per question
- [x] [F10](tasks/F10-foreign-tool-overhead.md) `closed` none: Foreign-tool overhead of the matcher-less tool.call hook
- [x] [F11](tasks/F11-request-path-overhead.md) `closed` none: Request path overhead vs a bare fetch, validation and JSON cost
- [x] [F12](tasks/F12-no-answer-cache.md) `closed` none: No answer cache for identical questions
- [x] [F13](tasks/F13-batch-shape-and-concurrency.md) `closed` none: Batch vs single requests, parallel calls
- [x] [F14](tasks/F14-timers-and-memory.md) `closed` none: Timer cleanup and module memory
- [x] [F15](tasks/F15-test-suite-runtime.md) `closed` none: Test-suite runtime
- [x] [F18](tasks/F18-haiku-call-not-cancelled-default-effort.md) `closed` low: The Haiku fallback call is not cancelled when abandoned and runs at the model's default effort
- [x] [F19](tasks/F19-jevfort-compaction-wait-and-hook-budget.md) `closed` medium: jevfort compaction now waits ~4.6 s for the ranking, and its 12 s / 15 s budgets exceed the engine's 10 s hook budget
- [x] [F20](tasks/F20-jevfort-budget-equals-api-timeout.md) `closed` none: jevfort's 4 s budget and jev-api's 4 s timeout race each other

## Notes

- F01 is worked in jevfort (`jevfort/src/hooks/register.mts`, `jevfort/src/hooks/jev.mts`, `jevfort/src/hooks/compact.mts`); jev-api itself cannot make System One faster.
- F02 and F03 touched the same code (since the rewrite: `RegState`, `registerOne`, `ensureTools`, both hooks).
- F05 and F06 touch `ask`/`askHaiku`'s race: do them together.
- F16 and F17 touched the same registration code (since the rewrite: `RegState`, `registerOne`, `ensureTools`, both hooks); F03 (a bounded wait) was its first step, F16 its residual.
- F19 was worked in jevfort (9 s budget, `$.clock.after` timer) and closed; no live check of the engine's hook limit was possible.
