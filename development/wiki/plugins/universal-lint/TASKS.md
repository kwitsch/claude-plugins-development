# universal-lint performance tasks

Source: performance analysis of the universal-lint hook (0.14.0) on 2026-11-07, WSL2, 12 cores, 9.7 GB RAM (node 24.22.2, git 2.43.0, npm 11.19.1, Claude Code 2.1.319). Five dimensions, each with an independent verification pass (refuted findings removed, corrected numbers used): JS/TS/sh/py benchmarks, other languages (PHP/Java/Kotlin/YAML/Markdown/CSS/Go/Rust), FileChanged and watch list, real Claude Code sessions (2908 transcripts mined plus live `claude -p --debug-file` runs), static hot-path walk. Linters: real binaries for tsc 7.0.2 (native), rtk 0.48.0, cargo/clippy, go vet; through npx (warm cache, plus cold runs with a fresh `npm_config_cache`) for eslint, markdownlint-cli2, stylelint, and oxlint (a root devDependency here, resolved by npx from `node_modules/.bin`); missing or replaced by instant stubs for shellcheck, ruff, yamllint, phpstan/psalm, ktlint, checkstyle, golangci-lint and markdownlint. One detail document per task in `tasks/`; read it before working on the task.

Finished: all of F01-F34 shipped or closed docs-only in 0.15.1-0.15.29 and 0.16.0 (F34, user-requested settle window); 0.15.30 was the final verification and docs pass (no code change). Current baseline: the F01 doc 'Measured' section (0.15.29); 0.16.0 numbers, the 0.15.30 A/B and the settle-window costs: [EVALUATION-2026-11-14.md](evaluations/EVALUATION-2026-11-14.md). Re-check recipes: development/wiki/plugins/universal-lint/README.md. F35-F37 (found by that evaluation) shipped in 0.16.1; 0.16.1 numbers (F35/F36 effect, precheck cost, corrected bursts): [EVALUATION-2026-11-14-v0.16.1.md](evaluations/EVALUATION-2026-11-14-v0.16.1.md), which opened F38 and F39 (section Remaining).

Measurements: every number in these documents is from one machine on one day, often under load (load average 6-8 while other benchmarks ran, about ±15% noise), and the machine's PATH carries 44 Windows `/mnt/c` dirs that inflate any PATH scan. Re-measure (F01), with `scripts/perf.ts`, before relying on a number, and judge each change against a fresh baseline.

rtk support was removed in 0.15.0. rtk mentions in the open tasks and notes describe the measured 0.14.x behavior.

Entry format and sections: `.claude/rules/plugin-docs-tasks.md`; `wiki-check.ts` checks them against the `tasks/` frontmatter.

## Remaining

- [ ] [F39](tasks/F39-settle-process-test-wall-time.md) `open` low: settle-process.test.ts now sets the test suite's wall time

## Done

- [x] [F01](tasks/F01-measurement-baseline.md) `done` medium: Per-event cost baseline and re-measurement harness
- [x] [F02](tasks/F02-rtk-failure-banner-as-finding.md) `done` high: rtk failure banners are reported as eslint findings (false rewake, pnpm install in the repo)
- [x] [F03](tasks/F03-eslint-without-config.md) `done` high: Skip the eslint chain when no eslint/oxlint config exists
- [x] [F04](tasks/F04-local-node-modules-bin.md) `done` high: Run project-local node_modules/.bin/<tool> directly instead of npx
- [x] [F05](tasks/F05-stdin-eagain-large-payload.md) `done` medium: Read hook stdin robustly; payloads over about 190 KB are silently not linted
- [x] [F06](tasks/F06-markdownlint-cli2-no-globs.md) `done` medium: Pass --no-globs to markdownlint-cli2
- [x] [F07](tasks/F07-stylelint-without-config.md) `done` medium: Skip stylelint when the project has no stylelint config
- [x] [F08](tasks/F08-watchlist-early-stop.md) `done` medium: Stop the watch-list filter once WATCH_LIMIT is exceeded
- [x] [F09](tasks/F09-bypass-npx-cached-bin.md) `done` high: Spawn the cached npx bin directly instead of npx --yes
- [x] [F10](tasks/F10-filechanged-concurrency-cap.md) `done` high: Cap concurrent FileChanged lints across hook processes (slot files)
- [x] [F11](tasks/F11-persist-path-probes.md) `done` medium: Persist onPath probe results across hook processes
- [x] [F12](tasks/F12-watchlist-scope-fast-path.md) `done` medium: Cheapen the watch list's per-file scope check (extension first, per-dir realpath cache)
- [x] [F13](tasks/F13-dedup-whole-project-checks.md) `done` medium: Run tsc / go vet / cargo once per FileChanged burst, not once per file
- [x] [F14](tasks/F14-rtk-eslint-defeats-edit-gate.md) `done` medium: Bypass rtk lint on Edit; its compacted output has no line locations, so the edit-range gate passes everything
- [x] [F15](tasks/F15-rearm-watches-after-checkout.md) `done` medium: Re-arm FileChanged watches after git checkout (prototype first)
- [x] [F16](tasks/F16-skill-driver-batching.md) `done` medium: Skill driver: one linter call per tool group and one tsc per tsconfig
- [x] [F17](tasks/F17-persist-rtk-probe.md) `done` low: Persist rtk rewrite probe results across hook processes
- [x] [F18](tasks/F18-overlap-chain-tsc-and-kill-tree.md) `done` low: Overlap chain lint and tsc; kill the whole process tree on timeout
- [x] [F19](tasks/F19-watchlist-skip-generated.md) `done` low: Keep linguist-generated files out of watchPaths
- [x] [F20](tasks/F20-config-walk-readdir.md) `done` low: One readdirSync per directory in the upward config walks (9P)
- [x] [F21](tasks/F21-gatefinding-exists-memo.md) `done` low: Memoize existsSync in gateFinding
- [x] [F22](tasks/F22-filechanged-skip-without-git.md) `done` low: FileChanged skip without a git status spawn (index blob id)
- [x] [F23](tasks/F23-superseded-and-duplicate-wakes.md) `done` low: Superseded and duplicate findings re-wake Claude
- [x] [F24](tasks/F24-npm-notice-in-findings.md) `done` low: Keep npm notice lines out of npx-run findings
- [x] [F25](tasks/F25-digest-size-bound.md) `done` low: Bound digest hashing and FileChanged lint by file size
- [x] [F26](tasks/F26-per-process-floor-and-hook-filter.md) `done` low: Per-process floor (about 40 ms) for events the hook cannot act on
- [x] [F27](tasks/F27-tests-miss-perf-paths.md) `done` low: Test the performance-relevant hook paths
- [x] [F28](tasks/F28-wsl-windows-path-docs.md) `done` medium: Document the WSL Windows-PATH penalty (mostly inside child processes)
- [x] [F29](tasks/F29-timeout-budget-docs.md) `done` low: Timeout budget doc misses the cold Rust leaf crate and SessionStart on 9P
- [x] [F30](tasks/F30-go-rust-cost-model-docs.md) `done` low: Document the Go/Rust cost model (scope, cold caches, bursts)
- [x] [F31](tasks/F31-rtk-shellcheck-overhead.md) `done` low: Measure rtk's overhead for shellcheck/ruff with the real tools
- [x] [F32](tasks/F32-filechanged-echo-race.md) `done` low: Measure how often the FileChanged echo of Claude's own write beats the digest
- [x] [F33](tasks/F33-watchpaths-size-recheck.md) `done` low: watchPaths JSON size and watch count need no change; re-check on Claude Code upgrades
- [x] [F34](tasks/F34-settle-window.md) `done` medium: Settle window - a finding that the next edit already repaired never wakes Claude
- [x] [F35](tasks/F35-skip-hold-when-nothing-droppable.md) `done` medium: Skip the settle hold when no held diagnostic can be dropped
- [x] [F36](tasks/F36-held-parse-error-fixed-elsewhere.md) `done` low: A held parse error is reported although a later edit fixed its cause on another line
- [x] [F37](tasks/F37-hook-design-rule-size.md) `done` low: hook-design.md is over the 40,000-character rule limit
- [x] [F40](tasks/F40-mid-edit-findings.md) `done` high: Mid-edit findings - route to the editing agent, report a burst's final state once, sweep at turn end

## Closed without code

- [x] [F38](tasks/F38-settle-docs-after-f36.md) `closed` low: Settle-window docs still describe the 0.16.0 parse-error rule

## Dependencies

- F37 before or with F35/F36: all three touch `hook-design.md` "Settle window (F34)"; F35's precheck counts a parse error as droppable, so F36 does not change it.
- F39 is independent (tests only).

- Before each task: re-run `node universal-lint/scripts/perf.ts` (F01, done) for a fresh baseline; each task's Verification compares against it.
- F02 + F03 together remove all false eslint findings seen in this analysis; F02 alone (the safety net) covers projects that have a config but no reachable binary. F04's walk from the file's directory fixes the sub-package case (91 of 128 historical pnpm findings).
- F04 before F09: both rework the npx-fallback branch of `runLintTool`; F04 covers locally installed tools, F09 the npx-cache-only ones (markdown).
- F11's savings and F04's are not additive for JS/TS: measured in F11 (0.15.9 -> 0.15.10, `perf.ts` medians, real PATH), `.mts` Write (local oxlint, F04 route) 387 -> 263 ms and `.ts` Write (tsc on PATH) 151 -> 141 ms, against `.sh`/`.py`/`.yml` (one missing PATH tool each) 142/144/146 -> 48/45/47 ms and `.md` 479 -> 292 ms; F28 documents the rest.
- F08 (done) shortened the `watchList` loop; F12 (done) cheapened the per-file check inside it; F19 (closed docs-only in 0.15.16) adds nothing to it (F15 closed docs-only, no re-emission).
- F10 before F13 (the slot cap bounds the peak; F13 removes redundant work inside it).
- F03 and F09 before F16. F10/F13/F18 changed the timeout budget (re-derived in hook-design.md with F18); F29 closed in 0.15.26.
- F27 (done, 0.15.24): the per-task tests were added with F04, F05, F10, F11, F18; the audit table in the F27 doc maps each item to its test.

## Notes

- Finding ids are local to this document set (F01-F39) and unrelated to `dprint/docs` ids; cross-references to dprint say "dprint F24" explicitly.
- Measured, no task:
  - Double plugin install: each debug log reads one hooks.json per plugin id, so the hook cost is not doubled. Whether the repo-explorer-mcp project pin shadows 0.14.0 was not pursued (closed with the F01 follow-ups in 0.15.30, reason in the F01 doc).
  - PostToolUse tsc cost grows with project size and with the importer count of the edited file: ts1000 296-335 ms for a leaf edit, 532-1210 ms after an edit to a widely imported module. Accepted under no-debounce. Only F18's overlap reduces wall time; F13 dedups FileChanged only.
- Out of scope (correctness, not perf; track separately): rtk-era (rtk removed in 0.15.0), kept as history: a `.go` file outside any module makes `rtk go vet` print "No issues found" but exit non-zero, and the hook reports that as a finding (exit 2).
- Two verifier corrections to keep in mind: the lstat-only watch-list fast path is NOT semantics-preserving (F12 uses a per-dir realpath cache instead), and dropping a lint as "stale" loses findings after disjoint Edits (F23).
