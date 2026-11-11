---
id: F27
title: Test the performance-relevant hook paths
status: done
priority: low
area: universal-lint/tests/*.test.mts, universal-lint/tests/support/lint-hook.mts
---

## Status

Done in 0.15.24. Audit of the eight proposed tests plus the perf paths added since: six were already covered by the tests added with their tasks, item 1 (rtk banner) and the rtk half of item 5 are obsolete (rtk removed in 0.15.0), only item 7 (2 MB output) was missing and is added. A quadratic `LOC_PATH_RE` hazard found while designing it is fixed in the same release.

### Audit

| #   | Item                                        | Verdict                                                             | Where                                                                                                                                                                                             |
| --- | ------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | rtk banner (F02)                            | Obsolete                                                            | rtk removed in 0.15.0, tests/rtk.test.mts deleted in e411490                                                                                                                                      |
| 2   | Local bin (F04)                             | Covered                                                             | npx-fallback.test.mts: local bin runs and npx never, nearest bin wins, keyed by bin name, no exec bit falls back to npx, never above cwd, PATH beats local; tsc.test.mts: `node_modules/.bin/tsc` |
| 3   | stdin late/large (F05)                      | Covered                                                             | core.test.mts `runLate` + `PAD` (512 KiB, written late through a pipe), Edit and Write: exit 0, shellcheck ran, digest written                                                                    |
| 4   | Slots (F10)                                 | Covered                                                             | file-detection.test.mts: 20 concurrent FileChanged, max overlap <= `FILE_CHANGED_SLOTS`; unusable slot dir fails open; give-up. registry.test.mts `acquireSlot` units                             |
| 5   | Probe persistence (F11/F17)                 | Covered (F11, by proxy); rtk half obsolete                          | core.test.mts probe block: persisted miss served, TTL expiry, hit revalidated, PATH change gives a separate file, corrupt or unusable store fails open                                            |
| 6   | Timeout (F18)                               | Covered at the spawnGroup seam                                      | spawn-group.test.mts: ETIMEDOUT and group gone, SIGKILL after grace, ENOENT, ENOBUFS at 11 MB, normal exit, hook SIGTERM kills live groups                                                        |
| 7   | 2 MB + located line, surfaced and truncated | Added by this task                                                  | truncation.test.mts "output over 1 MiB keeps its finding and is truncated"                                                                                                                        |
| 8   | Driver (F16)                                | Covered                                                             | skill.test.mts: one shellcheck call for 3 files, tsc once per tsconfig, single reruns after skip or kill, block cap per file, split per argv prefix                                               |
| +   | npx cache (F09)                             | Covered                                                             | npx-fallback.test.mts cache direct, cold cache, stale and future stamp, no exec bit, lock, above-cwd, npm_config env only on npx                                                                  |
| +   | Project-check lock (F13)                    | Covered                                                             | file-detection.test.mts: 10 .ts give 1 tsc, 5 .go, 5 .rs, newer change reruns, unusable lock dir; registry `coalesceProjectCheck` units                                                           |
| +   | configExists (F20)                          | Covered (behaviour)                                                 | registry.test.mts configExists block                                                                                                                                                              |
| +   | gateFinding memo (F21)                      | Covered (behaviour); count not observable without a production seam | registry.test.mts gateFinding block                                                                                                                                                               |
| +   | Lazy crypto (F26)                           | Covered (static)                                                    | manifest.test.mts: no static node:crypto import, createRequire fallback                                                                                                                           |
| +   | WATCH_LIMIT (F08/F12)                       | Covered                                                             | file-detection.test.mts limit tests                                                                                                                                                               |
| +   | LOC_PATH_RE cost (found in F27)             | Fixed and added by this task                                        | registry.test.mts gateFinding block, "a long whitespace-free line (minified) stays linear and keeps the located hit"                                                                              |

### LOC_PATH_RE fix

`LOC_PATH_RE` was unanchored, so a long whitespace-free line (minified or base64 output) cost quadratic time and could block `gateFinding` until the 90 s hook timeout killed the hook, losing the finding silently. Old regex: no-dot token 25 KB 0.79 s, 50 KB 2.5 s, 200 KB 42.5 s; minified-shaped `ab.c` token 200 KB 82.7 s. The token-start lookbehind `(?<![^\s:()[\]'"])` keeps matches identical (zero-width; differential over 10,418 repo lines plus every hook-design.md format: 0 differences) and makes it linear: 10 MiB single token 62 ms (no-dot) / 118 ms (dotty). A `{1,255}` bound was rejected (still 9.7 s on 10 MiB and truncates long paths).

### Mutation record

- A: `MAX_BUFFER_BYTES = 1024 * 1024` -> the truncation test fails (status 0 vs 2, ctx empty); spawn-group.test.mts ENOBUFS test passes `maxBuffer` explicitly and stays green, confirming the gap.
- B: `truncate` returns `collapsed` uncapped -> the truncation test fails (endsWith/length assertions, or harness ENOBUFS with status null).
- C: lookbehind removed from `LOC_PATH_RE` -> the registry gateFinding test fails by vitest timeout.
  All restored; `git diff universal-lint/src` shows only the regex line and its TSDoc line.

## Problem

No test asserted that output above the 1 MB spawnSync default survives (`MAX_BUFFER_BYTES`); the other gaps listed originally were closed by the tests added with their tasks (see Audit).

## Code locations

tests/skill.test.mts, truncation.test.mts, registry.test.mts, npx-fallback.test.mts, file-detection.test.mts, tsc.test.mts; tests/support/lint-hook.mts (`recStub`).

## Approach

1. rtk banner (F02): obsolete, rtk removed in 0.15.0.
2. Local bin (F04): covered.
3. stdin (F05): covered.
4. Slots (F10): covered.
5. Probe persistence (F11): covered; the rtk half (F17) is obsolete.
6. Timeout (F18): covered at the spawnGroup seam.
7. A stub printing 2 MB plus a located line -> finding surfaced and truncated: added.
8. Driver (F16): covered.

## Verification

`pnpm --filter universal-lint build && pnpm --filter universal-lint test`; each new test fails when the guarded behaviour is broken on purpose (Mutation record).

## Constraints

Tests run against the built plugin/; only test seams go into src; harness stays hermetic (PATH = bash/node/git plus stubs); no production env override; no tight wall-clock budgets (CI flakiness). Any change under universal-lint/ needs a version bump.

## Related

F02 (rtk, obsolete since 0.15.0), F04, F05, F10, F11, F16, F17 (rtk, obsolete since 0.15.0), F18, F21, dprint F28.
