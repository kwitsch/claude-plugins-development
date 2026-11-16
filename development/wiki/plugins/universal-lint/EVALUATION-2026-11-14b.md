# universal-lint evaluation 2026-11-14b (plugin 0.16.1)

Second dated evaluation of 2026-11-14, run after F35, F36 and F37 shipped in 0.16.1 on branch `feat/lint-settle-window` (HEAD `8197268`). The suffix `b` keeps [EVALUATION-2026-11-14.md](EVALUATION-2026-11-14.md) (0.16.0, same day) unchanged; its numbers are not edited. Purpose: check that the per-event cost holds, measure what F35 (skip the hold when nothing can be dropped) and F36 (a held parse error is dropped by any later edit) changed, compare with 0.16.0 on the same machine and day, and record what is left. New findings F38 and F39 in [TASKS.md](TASKS.md).

**One machine only**: WSL2 (kernel 6.18.33.2-microsoft-standard-WSL2), 12 cores, 9.5 GB RAM, ext4 work tree, Node v24.22.2, git 2.43.0, tsc 7.0.2 (native, on PATH), oxlint from the root `node_modules/.bin` (with `tsgolint`), Claude Code 2.1.325 installed but not used for measurements. None of shellcheck/ruff/yamllint/markdownlint-cli2/eslint/oxlint/stylelint on PATH (as in the earlier runs), so the `.sh`/`.py`/`.yml` rows time the missing-tool path and the settle benches use a stub shellcheck. PATH 62 dirs, 44 on `/mnt/c`. Load average 2.0-2.9 during the harness runs, then 6-8.4 from 07:33 on (other processes on the machine, not identified) for the bursts, the in-process benches and the test suite. Treat differences below ~15% as noise, and more than that for the rows measured under load 6-8. Re-measure before relying on a number.

## How it was measured

- **Build**: `pnpm --filter universal-lint build` reproduced the committed `plugin/` byte for byte (`git status --short` empty afterwards).
- **Harness**: `node universal-lint/scripts/perf.mts 10` (16 cases, real PATH and PATH minus `/mnt/`, one warm-up round plus 10 timed rounds, every run checked against its exit status and observable; median (min-max), no p90). A/B: the 0.16.0 commit `cdc9421` was cloned into the session scratchpad (root and plugin `node_modules` symlinked from this worktree, built `plugin/` as committed) and its own `perf.mts` was run alternately with this checkout's: 0.16.0, 0.16.1, 0.16.0, 0.16.1. The harnesses are identical.
- **Settle bench** (scratch `bench2/settle.mjs`, not committed; the method of EVALUATION-2026-11-14 with 0.16.0 in place of 0.15.30): spawns the built hooks of both versions through their shebang with a payload file as stdin, `CLAUDE_PLUGIN_DATA` in a temp dir, PATH = stub dir + node + `/usr/bin:/bin`. The stub `shellcheck` prints the content of a findings file (gcc format) and exits 1, or exits 0 when it is empty. 10 timed runs plus one warm-up per row, median and p90. New rows: foreign-only and unlocated-only on 0.16.0 too, a mixed finding (own line plus foreign) and an own-file parse error only (`a.sh:4:1: error: Couldn't find end of string [SC1009]`). Parked RSS: `/proc/<pid>/status` VmRSS 2.5 s into the hold, 5 samples. Large files: `.sh` Write of a 1 MB and a 10 MB file without any shellcheck, both versions alternated twice.
- **Bursts**: the settle bench's burst rows (N concurrent Writes of N distinct files, live hook processes and summed VmRSS sampled every 100 ms), plus scratch `bench2/burst.mjs`, whose stub prints the linted path itself, so every file gets an own-line finding (see "Comparison": the earlier burst stub did not).
- **Precheck bench** (scratch `bench2/precheck.mjs`): imports each built module in-process, `UNIVERSAL_LINT_SETTLE_MS=0`, journals an edit, rewrites the file and journals a later whole-file edit with another digest (so the post-hold filter runs in full), then times 55 `settleFindings` calls (10 for 20,000 lines) after 5 warm-up calls per finding of 1/100/2000/20,000 diagnostic lines, own-file (`a.sh:<n>:6: ...`) or foreign (`other<k>.sh:<n>:1: ...`). Two rounds per version.
- **Journal bench** (scratch `bench2/journal.mjs`, unchanged): 0.16.1 only (`recordEdit` is unchanged since 0.16.0).
- **Parse-error repro** (scratch `bench2/parse-repro.mjs`, unchanged): a Write whose lint reports a parse error at EOF, then 1 s later an Edit that fixes the cause on line 2 and lints clean. Two runs per version.
- **Suite and checks**: `pnpm --filter universal-lint test` 3 times plus one vitest JSON-reporter run each of 0.16.1 and of the 0.16.0 clone (per-file durations), `pnpm lint` once, `claude plugin validate universal-lint/plugin` once, `wc -m` of every rule file.

## Results

### Per-event cost (`perf.mts`, 10 runs per round)

Medians in ms, round 1 / round 2. "0.16.0 (a)" = the 0.16.0 column of EVALUATION-2026-11-14 (same machine, earlier that day).

| Case                               | 0.16.0 (a) real | 0.16.0 real | 0.16.1 real | 0.16.0 no /mnt | 0.16.1 no /mnt |
| ---------------------------------- | --------------: | ----------: | ----------: | -------------: | -------------: |
| floor `node -e 0`                  |         27 / 25 |     25 / 26 |     25 / 27 |        24 / 25 |        24 / 26 |
| empty payload `{}`                 |         40 / 39 |     38 / 41 |     38 / 40 |        38 / 39 |        39 / 40 |
| out-of-scope `.json` Write         |         43 / 39 |     38 / 39 |     39 / 40 |        40 / 39 |        39 / 42 |
| `.sh` Write                        |         50 / 48 |     47 / 49 |     49 / 51 |        45 / 47 |        46 / 48 |
| `.py` Write                        |         47 / 49 |     47 / 47 |     47 / 51 |        45 / 47 |        47 / 47 |
| `.yml` Write                       |         48 / 47 |     48 / 47 |     46 / 50 |        45 / 47 |        46 / 49 |
| `.md` Write                        |       295 / 293 |   287 / 287 |   287 / 289 |      284 / 291 |      289 / 302 |
| `.css` Write (no stylelint config) |         50 / 48 |     46 / 48 |     49 / 49 |        46 / 49 |        50 / 50 |
| `.ts` Write (no eslint config)     |       149 / 148 |   144 / 148 |   156 / 148 |      145 / 153 |      146 / 148 |
| `.ts` Edit (no eslint config)      |       146 / 148 |   145 / 150 |   149 / 153 |      145 / 153 |      145 / 148 |
| `.mts` Write (this repo)           |       335 / 322 |   278 / 297 |   310 / 319 |      306 / 298 |      307 / 307 |
| FileChanged tracked unchanged      |         51 / 52 |     49 / 51 |     51 / 52 |        50 / 51 |        50 / 54 |
| FileChanged ignored                |         53 / 52 |     50 / 50 |     50 / 52 |        48 / 51 |        50 / 53 |
| FileChanged unlink                 |         40 / 41 |     37 / 37 |     38 / 40 |        39 / 40 |        38 / 42 |
| SessionStart fixture               |         47 / 46 |     45 / 47 |     47 / 47 |        45 / 45 |        46 / 48 |
| SessionStart this repo             |         61 / 62 |     59 / 59 |     64 / 61 |        59 / 63 |        60 / 62 |

Every run of all four harness runs was `ok` (exit 0). No harness case has a finding, and `settleFindings` returns on `findings.length === 0` before the F35 precheck, so no 0.16.1 change can reach these rows; every gap is within noise. The largest, `.mts` Write real PATH 278/297 -> 310/319 ms, has overlapping ranges (260-407 against 284-507), is absent in the no-/mnt column (306/298 -> 307/307), and the same row read 335/322 for 0.16.0 earlier the same day.

### Settle hold (stub shellcheck, `.sh` Write)

| Case                                           | median ms | p90 ms | exit |
| ---------------------------------------------- | --------: | -----: | ---- |
| 0.16.0 clean (default hold)                    |        55 |     61 | 0    |
| 0.16.1 clean (default hold)                    |        50 |     54 | 0    |
| 0.16.0 own-line finding, default hold          |      5062 |   5065 | 2    |
| 0.16.1 own-line finding, `SETTLE_MS=0`         |        52 |     55 | 2    |
| 0.16.1 own-line finding, default hold          |      5058 |   5060 | 2    |
| 0.16.0 foreign-file finding only, default hold |      5064 |   5067 | 2    |
| 0.16.1 foreign-file finding only, default hold |        55 |     58 | 2    |
| 0.16.0 unlocated finding only, default hold    |      5066 |   5072 | 2    |
| 0.16.1 unlocated finding only, default hold    |        62 |     70 | 2    |
| 0.16.1 mixed own-line + foreign, default hold  |      5064 |   5069 | 2    |
| 0.16.1 own-file parse error only, default hold |      5069 |   5082 | 2    |

F35 confirmed: a foreign-only or unlocated-only finding now reaches Claude 55-62 ms after the Write instead of about 5.06 s, the no-hold figure (0.16.1 `SETTLE_MS=0`: 52 ms; 0.15.30 in EVALUATION-2026-11-14: 54 ms). Own-line, mixed and parse-error findings keep the full hold, as specified (a parse error is droppable since F36, so the precheck holds it). Parked hook RSS during the hold: 55.96-56.05 MB (5 samples, 0.16.1), unchanged.

### Bursts of Writes with findings

| N concurrent Writes, kind of finding |   0.16.0 wall |   0.16.1 wall | 0.16.0 peak live / summed RSS | 0.16.1 peak live / summed RSS |
| ------------------------------------ | ------------: | ------------: | ----------------------------: | ----------------------------: |
| 10, every file an own-line finding   | 5225, 5149 ms | 5215, 5154 ms |               10 / 545-546 MB |                   10 / 546 MB |
| 30, every file an own-line finding   | 5311, 5301 ms | 6848, 5412 ms |                 30 / 1,637 MB |           30 / 1,636-1,637 MB |
| 10, one own-line + 9 foreign         |       5187 ms |       5108 ms |                   10 / 546 MB |                    6 / 300 MB |
| 30, one own-line + 29 foreign        |       5312 ms |       5178 ms |                 30 / 1,637 MB |                   10 / 500 MB |
| 30, foreign only                     |       5329 ms |        441 ms |                 30 / 1,637 MB |                 22 / 1,085 MB |

All runs exited 2, every file's finding was reported (all-own rows: `own-marker` in all 10/30 stderr texts). A burst whose findings can be dropped still parks one node process per lint for the hold (F34 residual (6), unchanged by design); the 6848 ms run fell in the load spike (load 8.4). With foreign findings only, 0.16.1 ends the whole burst in 441 ms; its peak of 22 live processes / 1,085 MB is the concurrent start-up of the lints themselves, not a hold (summed RSS overcounts shared pages, an upper bound).

### F35 precheck cost (`settleFindings`, in-process, hold 0)

Median us (p90 in brackets), round 1 / round 2. Size = finding text.

| Finding               |    Size | 0.16.0                            | 0.16.1                            |
| --------------------- | ------: | --------------------------------- | --------------------------------- |
| own, 1 line           |   0 KiB | 75 (155) / 105 (162)              | 100 (175) / 81 (154)              |
| own, 100 lines        |   3 KiB | 188 (329) / 193 (385)             | 340 (572) / 414 (719)             |
| own, 2000 lines       |  70 KiB | 2,710 (3,689) / 2,806 (4,030)     | 7,082 (8,053) / 6,387 (7,741)     |
| own, 20,000 lines     | 721 KiB | 25,776 (33,486) / 34,072 (49,014) | 60,827 (70,370) / 55,564 (72,550) |
| foreign, 1 line       |   0 KiB | 41 (113) / 60 (90)                | 5 (10) / 5 (9)                    |
| foreign, 100 lines    |   4 KiB | 178 (262) / 249 (317)             | 165 (232) / 152 (197)             |
| foreign, 2000 lines   |  89 KiB | 2,581 (3,396) / 3,344 (5,145)     | 3,463 (4,452) / 2,922 (3,489)     |
| foreign, 20,000 lines | 931 KiB | 24,212 (26,763) / 31,969 (36,577) | 30,074 (36,737) / 29,585 (32,308) |

One `gateFinding` pass costs about 1.2-1.7 us per diagnostic line here. An own-file finding now pays two passes (the precheck before the hold, the filter after it): about 2.2x 0.16.0, +20-35 ms at 721 KiB, against a 5,000 ms hold. A foreign finding pays one pass in both versions (0.16.1's precheck replaces the filter) and skips the hold and the journal read. No task: the extra pass stays below 1% of the hold up to about 1 MB of finding text, and at the 10 MiB per-stream output cap it would be about 0.4 s (8% of the hold) on output that size; `lintResolved` already runs one pass of the same gate.

### Journal (`recordEdit`, `settleFindings`, 0.16.1, in-process)

| Entries in `settle/` | `recordEdit` median us | p90 us | own records read | `settleFindings` median us | p90 us |
| -------------------: | ---------------------: | -----: | ---------------: | -------------------------: | -----: |
|                    0 |                    220 |    362 |               53 |                        530 |    938 |
|                  100 |                    336 |    430 |               72 |                        858 |  1,094 |
|                 1000 |                  1,419 |  1,844 |              200 |                      4,081 |  4,718 |
|                 5000 |                  7,722 |  9,357 |              200 |                      7,846 |  9,721 |

Same shape as on 0.16.0 (linear in the entries younger than 90 s); 20-40% higher, measured at load 6-8 against about 2 for the 0.16.0 figures (182/310/1,300/5,585 us). `recordEdit` is unchanged; this bench's `settleFindings` column now includes the F35 precheck pass of its one own-line finding. No task (as on 0.16.0).

### Extra digests (`.sh` Write, no shellcheck, clean)

| File size | 0.16.0 median ms (2 rounds) | 0.16.1 median ms (2 rounds) |
| --------- | --------------------------: | --------------------------: |
| 1 MB      |                     87 / 63 |                     66 / 65 |
| 10 MB     |                   122 / 131 |                   112 / 131 |

Code unchanged between the versions; both are 30-60 ms above the 0.16.0 figures of EVALUATION-2026-11-14 (50 / 81 ms), measured at load 6-8. Not comparable across the two runs; no task.

### Parse-error repro (F36)

| Version | Write with the parse error (held)                    | Edit fixing line 2 |
| ------- | ---------------------------------------------------- | ------------------ |
| 0.16.0  | exit 2 after 5069, 5080 ms, `a.sh:4:1: ... [SC1009]` | exit 0, 55-57 ms   |
| 0.16.1  | exit 0 after 5073, 6583 ms, no output                | exit 0, 63-88 ms   |

F36 confirmed: the held parse error is dropped once a later edit exists, so the repaired case no longer wakes Claude. The process still waits out its hold (it is held because it can be dropped).

### Test suite

0.16.1: 19 files, 366 tests passed in all 3 runs (plus the JSON run), vitest 24.12-24.47 s, wall 25.5-27.0 s, max RSS 139-140 MB (0.16.0 on 2026-11-14: 360 tests, 19.41-19.74 s at load about 2). Per file (JSON reporter, same load, one run each): `settle-process.test.mts` 17.4 s with 10 tests on 0.16.0, 25.5 s with 14 on 0.16.1, now the slowest file and so the suite's wall time (0.16.0's slowest was `file-detection.test.mts`, 22.4 s; suite 22.5 s -> 25.5 s). The file's tests run one after the other and wait out holds of 0.7-3 s each (F39). `pnpm lint` exit 0; `claude plugin validate universal-lint/plugin`: passed.

### Rule file sizes (`wc -m`)

hook-design.md 36,717, languages.md 13,001, settle-window.md 5,846, typescript-check.md 4,636, line-length-guard.md 3,671, skill-driver.md 2,996, tests.md 2,475: all under 40,000 (F37 holds).

## Comparison with the earlier figures

- EVALUATION-2026-11-14 (0.16.0): every per-event row within noise of today's 0.16.0 and 0.16.1 runs. Foreign-only 5081 -> 55 ms and unlocated-only 5078 -> 62 ms (F35's target "about 54 ms" reached). The own-line hold (5061 -> 5058 ms) and the parked RSS (56.0-56.1 MB) are unchanged.
- Correction to the burst method of EVALUATION-2026-11-14: its stub printed `b0.sh:2:6: ...` for every file, so in each burst only `b0.sh` had an own-line finding and the other N-1 findings were foreign. On 0.16.0 that changes nothing (every finding is held, and today's all-own rows match its 10 / 546 MB and 30 / 1,638 MB); on 0.16.1 it does, hence the separate all-own rows above. The old numbers stay as they are.
- F01 baseline (0.15.29): unchanged picture (missing-tool rows 45-51 ms, `.md` Write 284-302 ms, floor 38-42 ms).
- F32 race margin and F33 watch counts were not re-measured (no live session).
- F35's and F36's own claims: the process-test thresholds (foreign/unlocated exit under 1000 ms at hold 1500 ms; parse error fixed elsewhere: exit 0) are now backed by the bench rows and the repro above.

## Findings summary

| Id  | Priority | Status | Finding                                                                                                                          | Proof                                   |
| --- | -------- | ------ | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| F38 | low      | open   | README says "edits elsewhere drop nothing" and settle-window.md "Lines." still shows `gateFinding(..., false)`; both predate F36 | `grep` (1 hit each), parse-error repro  |
| F39 | low      | open   | `settle-process.test.mts` (14 sequential hold-bound tests) is now the slowest test file and sets the suite's wall time           | vitest JSON: 17.4 -> 25.5 s, suite +3 s |
| -   | none     | -      | F35 precheck is a second gate pass for droppable findings (about 1.2-1.7 us per diagnostic line, +20-35 ms at 721 KiB)           | precheck bench, no task                 |

## Remaining findings

- **F38**: docs drift after F36 in the user-facing README and in `settle-window.md`; docs only.
- **F39**: dev-loop cost: run the independent settle process tests concurrently (or shorten holds that only need "held at all"), so the suite falls back to the next slowest file.
- Unchanged and still accepted: a burst of droppable findings parks one node process per lint for the hold (F34 residual (6), about 56 MB each); headless `claude -p` does not background `asyncRewake` hooks, so a held finding delays that turn (F34 residual (1); since F35 only for findings that can be dropped; not re-measured live); extra digests and the journal prune as on 0.16.0.

## Bug hunt

No parallel reviewer run (the `bughunt` skill was not used). Read for this evaluation: the diff `f3aa84e..8197268` (`settleFindings`, `gateFinding`, the rule move of F37) and `recordEdit`, `settleWaitMs`, `carryLine`, `editHunks`. Checked: the precheck never skips a hold the filter could use (its predicate rejects every own-file line, the worst case of the filter's `survives`, and both calls pass `"drop"`, so a parse error the filter could drop also fails the precheck); a clean lint never reaches the precheck; an exception in the precheck holds as before. Found: docs drift (F38). Measured: F35 and F36 behave as shipped (bench rows, repro). No code was changed (docs only).

## Live validation

Not run: no `claude -p` or interactive Claude Code session, so the effect of F35 on a real turn (interactive wake time, the headless delay for foreign-only findings), the F32 echo race and the F33 watch counts are not re-measured here. All numbers above come from spawning the built hooks directly, as `hooks.json` does, without Claude Code's dispatch.
