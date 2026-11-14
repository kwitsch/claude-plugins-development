# universal-lint evaluation 2026-11-14 (plugin 0.16.0)

First dated evaluation of universal-lint, run after the settle window (F34, 0.16.0) on branch `feat/lint-settle-window` (HEAD `cdc9421`). Purpose: check that the per-event cost of the F01-F33 work holds, measure what the settle window costs (journal, extra digests, the hold itself, bursts), compare with the F01 baseline (0.15.29) and with 0.15.30 on the same day, and record what is left. New findings F35-F37 in [TASKS.md](TASKS.md).

**One machine only**: WSL2 (kernel 6.18.33.2-microsoft-standard-WSL2), 12 cores, 9.5 GB RAM, ext4 work tree, Node v24.22.2, tsc 7.0.2 (native, on PATH), oxlint from the root `node_modules/.bin` (with `tsgolint`), Claude Code 2.1.325 installed but not used for measurements. None of shellcheck/ruff/yamllint/markdownlint-cli2/eslint/oxlint/stylelint on PATH (as in the F01 baseline), so the `.sh`/`.py`/`.yml` rows time the missing-tool path and the settle bench uses a stub shellcheck. PATH 62 dirs, 44 on `/mnt/c`. Load average 0.63 -> 2.30 during the harness runs, up to 5.4 during the burst bench. Treat differences below ~15% as noise. Re-measure before relying on a number.

## How it was measured

- **Build**: `pnpm --filter universal-lint build` reproduced the committed `plugin/` byte for byte (`git status --short` empty afterwards).
- **Harness**: `node universal-lint/scripts/perf.mts 10` (16 cases, real PATH and PATH minus `/mnt/`, one warm-up round plus 10 timed rounds, every run checked against its exit status and observable). The harness prints median (min-max), not p90. A/B: the 0.15.30 merge base (`7ad8ac8`) was cloned into the session scratchpad (root `node_modules` symlinked from this worktree, built `plugin/` as committed) and its own `perf.mts` was run alternately with this checkout's: 0.15.30, 0.16.0, 0.15.30, 0.16.0. The two harnesses differ only in `UNIVERSAL_LINT_SETTLE_MS=0`, which changes nothing here (no harness case has a finding).
- **Settle bench** (scratch `bench/settle.mjs`, not committed): spawns the built hooks of both versions through their shebang with a payload file as stdin, `CLAUDE_PLUGIN_DATA` in a temp dir, PATH = stub dir + node + `/usr/bin:/bin`. The stub `shellcheck` prints the content of a findings file (gcc format, `a.sh:2:6: note: ... [SC2086]`) and exits 1, or exits 0 when it is empty. 10 timed runs plus one warm-up per row, median and p90. Hold rows: the default hold (env unset) and `UNIVERSAL_LINT_SETTLE_MS=0`. Parked RSS: `/proc/<pid>/status` VmRSS 2.5 s into the hold, 5 samples. Bursts: N concurrent Writes of N distinct files that all get a finding, live hook processes and summed VmRSS sampled every 100 ms. Large files: `.sh` Write of a 1 MB and a 10 MB file without any shellcheck (clean path), both versions alternated twice.
- **Journal bench** (scratch `bench/journal.mjs`): imports the built 0.16.0 module in-process and times 200 `recordEdit` calls and 50 `settleFindings` calls (hold 0) with M = 0/100/1000/5000 foreign entries pre-filled in `settle/`.
- **Residual repro** (scratch `bench/parse-repro.mjs`): a Write whose lint reports a parse error at EOF, then 1 s later an Edit that fixes the cause on line 2 and lints clean (the documented residual (9) of the settle window).
- **Suite and checks**: `pnpm --filter universal-lint test` 3 times (0.15.30 suite twice in the clone), `pnpm lint` once, `claude plugin validate universal-lint/plugin` once.

## Results

### Per-event cost (`perf.mts`, 10 runs per round)

Medians in ms, round 1 / round 2. 0.15.29 = the F01 "Measured" table (5 runs, 2026-11-11).

| Case                               | 0.15.29 real / no /mnt | 0.15.30 real | 0.16.0 real | 0.15.30 no /mnt | 0.16.0 no /mnt |
| ---------------------------------- | ---------------------: | -----------: | ----------: | --------------: | -------------: |
| floor `node -e 0`                  |                24 / 26 |      26 / 26 |     27 / 25 |         25 / 26 |        25 / 25 |
| empty payload `{}`                 |                38 / 39 |      40 / 40 |     40 / 39 |         41 / 39 |        41 / 40 |
| out-of-scope `.json` Write         |                38 / 38 |      39 / 40 |     43 / 39 |         39 / 40 |        41 / 40 |
| `.sh` Write                        |                47 / 48 |      47 / 48 |     50 / 48 |         47 / 46 |        48 / 48 |
| `.py` Write                        |                47 / 44 |      46 / 48 |     47 / 49 |         46 / 46 |        50 / 49 |
| `.yml` Write                       |                46 / 47 |      47 / 48 |     48 / 47 |         48 / 46 |        49 / 51 |
| `.md` Write                        |              276 / 283 |    292 / 295 |   295 / 293 |       290 / 287 |      296 / 293 |
| `.css` Write (no stylelint config) |                46 / 45 |      48 / 48 |     50 / 48 |         48 / 47 |        48 / 48 |
| `.ts` Write (no eslint config)     |              150 / 146 |    141 / 149 |   149 / 148 |       152 / 144 |      150 / 151 |
| `.ts` Edit (no eslint config)      |              148 / 141 |    147 / 142 |   146 / 148 |       151 / 147 |      152 / 155 |
| `.mts` Write (this repo)           |              299 / 332 |    312 / 305 |   335 / 322 |       311 / 319 |      316 / 329 |
| FileChanged tracked unchanged      |                49 / 51 |      53 / 50 |     51 / 52 |         50 / 50 |        51 / 55 |
| FileChanged ignored                |                48 / 49 |      51 / 50 |     53 / 52 |         49 / 49 |        51 / 52 |
| FileChanged unlink                 |                38 / 40 |      40 / 40 |     40 / 41 |         39 / 39 |        42 / 40 |
| SessionStart fixture               |                44 / 44 |      47 / 48 |     47 / 46 |         46 / 43 |        46 / 48 |
| SessionStart this repo             |                53 / 56 |      64 / 63 |     61 / 62 |         62 / 61 |        63 / 63 |

Every run of all four harness runs was `ok` (exit 0). The settle window adds no measurable cost to a clean lint: every 0.16.0 median is within noise of the 0.15.30 median of the same day (largest gap: `.mts` Write 312/305 -> 335/322 ms with overlapping ranges, 297-489 against 274-401, on the noisiest row, while the load rose to 2.30). The FileChanged rows now journal an edit before the git gate (`recordEdit`) and still sit within 1-5 ms of 0.15.30. "SessionStart this repo" is 61-64 ms for both versions against 53 ms on 2026-11-11: the checkout grew, not the code.

### Settle hold (stub shellcheck, `.sh` Write)

| Case                                           | median ms | p90 ms | exit |
| ---------------------------------------------- | --------: | -----: | ---- |
| 0.15.30 clean                                  |        53 |     56 | 0    |
| 0.16.0 clean (default hold)                    |        53 |     59 | 0    |
| 0.15.30 own-line finding                       |        54 |     56 | 2    |
| 0.16.0 own-line finding, `SETTLE_MS=0`         |        54 |     57 | 2    |
| 0.16.0 own-line finding, default hold          |      5061 |   5062 | 2    |
| 0.16.0 foreign-file finding only, default hold |      5081 |   5086 | 2    |
| 0.16.0 unlocated finding only, default hold    |      5078 |   5085 | 2    |

A clean lint never waits; a finding reaches Claude 5.0 s later than in 0.15.30 (the requested hold), measured from the end of the lint as specified. The foreign-only and unlocated-only findings come out byte-identical after the hold: the post-hold filter can never drop them (`gateFinding` keeps foreign and unlocated text), so they wait 5 s for nothing (F35). Parked hook RSS during the hold: 56.0-56.1 MB (5 samples).

### Bursts of Writes with findings

| N concurrent Writes, all with a finding | 0.15.30 wall | 0.16.0 wall | 0.16.0 peak live hooks | 0.16.0 peak summed RSS |
| --------------------------------------- | -----------: | ----------: | ---------------------: | ---------------------: |
| 10                                      |        97 ms |     5102 ms |                     10 |                 546 MB |
| 30                                      |       276 ms |     6581 ms |                     30 |               1,638 MB |

All runs exited 2. With 0.15.30 the 100 ms sampler saw at most one live hook (the lints end in under 100 ms); with 0.16.0 every hook stays parked for its hold. Summed RSS overcounts shared pages, so it is an upper bound. This quantifies the documented residual (6) of the settle window ("a burst of N Edits with findings parks N node processes for up to 5 s each"); no child processes are held.

### Journal (`recordEdit`, `settleFindings`, in-process)

| Entries in `settle/` | `recordEdit` median us | p90 us | own records read | `settleFindings` median us | p90 us |
| -------------------: | ---------------------: | -----: | ---------------: | -------------------------: | -----: |
|                    0 |                    182 |    251 |               41 |                        399 |    568 |
|                  100 |                    310 |    362 |               66 |                        656 |    827 |
|                 1000 |                  1,300 |  1,570 |              200 |                      2,522 |  2,981 |
|                 5000 |                  5,585 |  6,218 |              200 |                      6,378 |  7,029 |

`recordEdit` prunes with one `readdirSync` per call, so it is linear in the entries younger than 90 s (all sessions on the data dir). The in-process loop reuses one pid, so calls in the same millisecond overwrite one record ("own records read" < 200 at M = 0/100); real hooks have one pid each. FileChanged journals before the git gate, so a checkout that touches N watched files writes N records: at the `WATCH_LIMIT` of 5000 the last ones pay about 5.6 ms on a 50 ms floor (about +5% summed over the burst). No task.

### Extra digests (`.sh` Write, no shellcheck, clean)

| File size | 0.15.30 median ms (2 rounds) | 0.16.0 median ms (2 rounds) |
| --------- | ---------------------------: | --------------------------: |
| 1 MB      |                      48 / 47 |                     50 / 50 |
| 10 MB     |                      55 / 56 |                     81 / 81 |

A Write/Edit now reads and hashes the file three times (`recordWritten`, the journal record in `recordEdit`, `d0`) and a fourth time when there are findings (`d1`), against once in 0.15.30: about +2.5 ms per MB. The record's digest and `d0` are taken back to back, so one of them could serve both. No task: as in F25, a real linter on a file of that size runs for seconds, and below 1 MB the difference is inside the noise.

### Test suite

0.16.0: 19 files, 360 tests passed in all 3 runs, vitest 19.41-19.74 s, wall 20.2-22.1 s, max RSS 140 MB. 0.15.30 in the clone: 321 tests, 19.72-19.75 s. The 39 settle tests add no wall time (vitest runs the files in parallel; the process tests use holds of 0.7-3 s). `pnpm lint` exit 0; `claude plugin validate universal-lint/plugin`: passed.

## Comparison with the earlier figures

- F01 baseline (0.15.29, 2026-11-11): every row within about 12% of today's medians (both versions, so day and load, not code) except "SessionStart this repo" (larger checkout, same on 0.15.30). The F11/F04/F09/F26 savings hold: missing-tool rows 46-51 ms (0.14.0: 143-215 ms), `.md` Write 293-296 ms (0.14.0: 1113-1137 ms), floor 39-41 ms.
- F32 race margin (p50 600 ms) and F33 watch counts were not re-measured (no live session).
- F34's own claims: the 5 s hold and "clean lints never wait" are confirmed by the settle bench; "a held finding never keeps a slot" was not measured here (covered by `tests/settle-process.test.mts`, which passed); the RSS, burst, journal and digest figures are new.

## Findings summary

| Id  | Priority | Status | Finding                                                                                                    | Proof                        |
| --- | -------- | ------ | ---------------------------------------------------------------------------------------------------------- | ---------------------------- |
| F35 | medium   | open   | findings the settle filter can never drop (foreign-file only, unlocated only) are still held 5 s           | settle bench (5078-5081 ms)  |
| F36 | low      | open   | a held parse error is reported although a later edit fixed its cause on another line (residual (9))        | repro (exit 2 after 5064 ms) |
| F37 | low      | open   | `.claude/rules/hook-design.md` is 42,361 characters, over the repo's 40,000-character rule limit           | `wc -m` (0.15.30: 36,010)    |
| -   | none     | -      | extra digests (+2.5 ms/MB), journal prune (linear, 5.6 ms at 5000 entries), parked RSS 56 MB per held lint | benches above, no task       |

## Remaining findings

- **F35**: skip the hold when no finding has a diagnostic the post-hold filter could drop. Saves the full 5 s of wake latency and the parked process for cross-file tsc/go/cargo diagnostics and unlocated formats (phpstan tables); mixed findings keep the hold.
- **F36**: hook-design.md "Settle window" residual (9) was marked "Open (found by the final code review, not fixed)" with a candidate fix but no task; reproduced here: the Write's held `SC1009` at EOF was reported after 5064 ms although the Edit 1 s later fixed the unclosed quote on line 2 and linted clean. The second half of that residual (a late FileChanged echo journals a whole-file edit) loses nothing (the FileChanged lint re-reports) and gets no task.
- **F37**: docs drift: F34's "Settle window" section took `hook-design.md` from 36,010 to 42,361 characters.
- Unchanged and still accepted: headless `claude -p` does not background `asyncRewake` hooks, so there every lint with findings delays the turn by the full hold (F34 residual (1), reopen trigger in the F34 doc; not re-measured).

## Bug hunt

No parallel reviewer run (the `bughunt` skill was not used). Read for this evaluation: `recordEdit`, `settleFindings`, `settleWaitMs`, `lintFileHandler`, `fileChangedHandler`, `gateFinding` and `main` of `src/hooks/lint-file.mts`. Confirmed by a repro: F36 (documented, untracked). Checked and found as documented: the hold sits after the FileChanged slot release; `d1` is read only when there are findings; the prune covers future-dated names (`Math.abs`); a malformed record fails open to "report". No fix was made (docs only).

## Live validation

Not run: no `claude -p` or interactive Claude Code session, so the hold's effect on a real turn, the headless delay, the F32 echo race and the F33 watch counts are not re-measured here (F34's own live checks on Claude Code 2.1.325 are in the F34 doc). All numbers above come from spawning the built hook directly, as `hooks.json` does, without Claude Code's dispatch.
