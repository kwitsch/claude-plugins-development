# jev-api performance tasks

Source: performance analysis of jev-api 0.3.1 on 2026-11-13, numbers in [EVALUATION-2026-11-13.md](EVALUATION-2026-11-13.md). One document per finding in `tasks/`; read it before working on the task. Proven = measured in the harness or shown by the code; estimated = a derived figure (token counts, engine behaviour not run), marked as such in each task.

Legend: `[x]` finished (done, or closed without code: status `closed` in the task document). `[ ]` not finished; tag = `open` (not started), `partial`, `docs-only` (no code change intended; the remaining action is a documentation sentence).

## Done

- [x] [F01](tasks/F01-jevfort-budget-below-batch-latency.md) jevfort's 4 s askJev budget is below real System One latency for large batches (compaction of 30 items: 4.1 s)
- [x] [F02](tasks/F02-failed-registration-never-retried.md) bug: a failed tool registration is never retried in the session
- [x] [F03](tasks/F03-owned-call-awaits-registration.md) bug: a hanging `$.tool.register` blocks session.start and every owned tool call
- [x] [F04](tasks/F04-haiku-maxtokens-many-options.md) bug: Haiku fallback maxTokens too small for a choice with more than ~40 options
- [x] [F05](tasks/F05-pre-aborted-call-sends-request.md) bug: an already abandoned call still sends its System One request
- [x] [F06](tasks/F06-abort-listener-not-removed.md) Abort listeners stay on `next.signal` after the call settles
- [x] [F07](tasks/F07-env-reads-before-validation.md) Four `$.env.get` dispatches per owned call, also for invalid input
- [x] [F09](tasks/F09-abandoned-request-not-cancelled.md) A timed-out or abandoned request keeps running on the server

## Remaining

None: every finding is done or closed.


## Closed without code (measurement records, decided 2026-11-13)

- [x] [F10](tasks/F10-foreign-tool-overhead.md) Foreign-tool overhead of the matcher-less tool.call hook (+0.1 us per call)
- [x] [F11](tasks/F11-request-path-overhead.md) Request path overhead vs a bare fetch, validation and JSON cost
- [x] [F12](tasks/F12-no-answer-cache.md) No answer cache for identical questions
- [x] [F13](tasks/F13-batch-shape-and-concurrency.md) Batch vs single requests, parallel calls
- [x] [F14](tasks/F14-timers-and-memory.md) Timer cleanup and module memory
- [x] [F15](tasks/F15-test-suite-runtime.md) Test-suite runtime
- [x] [F08](tasks/F08-haiku-prompt-repeats-criteria.md) Haiku prompt repeats identical criteria per question (26% of a compaction prompt)

## Notes

- F01 is worked in jevfort (`jevfort/src/hooks/register.mts`, `jevfort/src/hooks/jev.mts`, `jevfort/src/hooks/compact.mts`); jev-api itself cannot make System One faster.
- F02 and F03 touch the same code (`registering`, `registerTools`, both hooks): do them together.
- F05 and F06 touch `ask`/`askHaiku`'s race: do them together.
