# universal-lint performance tasks

Source: performance analysis of the universal-lint hook (0.14.0) on 2026-11-07, WSL2, 12 cores, 9.7 GB RAM (node 24.22.2, git 2.43.0, npm 11.19.1, Claude Code 2.1.319). Five dimensions, each with an independent verification pass (refuted findings removed, corrected numbers used): JS/TS/sh/py benchmarks, other languages (PHP/Java/Kotlin/YAML/Markdown/CSS/Go/Rust), FileChanged and watch list, real Claude Code sessions (2908 transcripts mined plus live `claude -p --debug-file` runs), static hot-path walk. Linters: real binaries for tsc 7.0.2 (native), rtk 0.48.0, cargo/clippy, go vet; through npx (warm cache, plus cold runs with a fresh `npm_config_cache`) for eslint, markdownlint-cli2, stylelint, and oxlint (a root devDependency here, resolved by npx from `node_modules/.bin`); missing or replaced by instant stubs for shellcheck, ruff, yamllint, phpstan/psalm, ktlint, checkstyle, golangci-lint and markdownlint. One detail document per task in `tasks/`; read it before working on the task.

Measurements: every number in these documents is from one machine on one day, often under load (load average 6-8 while other benchmarks ran, about ±15% noise), and the machine's PATH carries 44 Windows `/mnt/c` dirs that inflate any PATH scan. Re-measure (F01), with `scripts/perf.mts`, before relying on a number, and judge each change against a fresh baseline.

rtk support was removed in 0.15.0. rtk mentions in the open tasks and notes describe the measured 0.14.x behavior.

Legend: `[x]` finished. `[ ]` not finished; tag = `open` (code change, not started), `partial`, `docs-only` (only a documentation change intended), `measurement-only` (measure first; any code change is decided afterwards).

## Done

- [x] [F01](tasks/F01-measurement-baseline.md) Per-event cost baseline and re-measurement harness: `node universal-lint/scripts/perf.mts`, numbers in hook-design.md "Measured cost".
- [x] [F02](tasks/F02-rtk-failure-banner-as-finding.md) rtk failure banners are reported as eslint findings (false rewake on every JS/TS edit, pnpm install in the repo). Obsolete: rtk support removed in 0.15.0.
- [x] [F14](tasks/F14-rtk-eslint-defeats-edit-gate.md) Bypass `rtk lint` on Edit: its compacted output has no line locations, so the edit-range gate passes everything. Obsolete: rtk support removed in 0.15.0.
- [x] [F17](tasks/F17-persist-rtk-probe.md) Persist `rtk rewrite` probe results across hook processes. Obsolete: rtk support removed in 0.15.0.
- [x] [F31](tasks/F31-rtk-shellcheck-overhead.md) Measure rtk's overhead for shellcheck/ruff with the real tools. Obsolete: rtk support removed in 0.15.0.
- [x] [F03](tasks/F03-eslint-without-config.md) Skip the eslint chain when no eslint/oxlint config exists. Shipped in 0.15.2.
- [x] [F04](tasks/F04-local-node-modules-bin.md) Run project-local `node_modules/.bin/<tool>` directly instead of npx. Shipped in 0.15.3.
- [x] [F05](tasks/F05-stdin-eagain-large-payload.md) Read hook stdin robustly: payloads over about 190 KB, or from a late writer, were silently not linted. Shipped in 0.15.4.
- [x] [F06](tasks/F06-markdownlint-cli2-no-globs.md) Pass `--no-globs` to markdownlint-cli2 so a project config's top-level `globs` no longer makes every single-file lint lint the whole repo. Shipped in 0.15.5.
- [x] [F07](tasks/F07-stylelint-without-config.md) Skip stylelint when the project has no stylelint config. Shipped in 0.15.6.
- [x] [F08](tasks/F08-watchlist-early-stop.md) Stop the watch-list filter once `WATCH_LIMIT` is exceeded. Shipped in 0.15.7.
- [x] [F09](tasks/F09-bypass-npx-cached-bin.md) Spawn the cached npx bin directly instead of `npx --yes`. Shipped in 0.15.8.
- [x] [F10](tasks/F10-filechanged-concurrency-cap.md) Cap concurrent FileChanged lints across hook processes (slot files). Shipped in 0.15.9.

## Stage 2: structural changes

- [ ] [F11](tasks/F11-persist-path-probes.md) Persist `onPath` probe results across hook processes `open` priority:medium. Ship with F28 (most of the WSL PATH cost is outside the plugin).
- [ ] [F12](tasks/F12-watchlist-scope-fast-path.md) Cheapen the watch list's per-file scope check (extension first, per-dir realpath cache) `open` priority:medium
- [ ] [F13](tasks/F13-dedup-whole-project-checks.md) Run tsc / go vet / cargo once per FileChanged burst, not once per file `open` priority:medium. After F10.
- [ ] [F15](tasks/F15-rearm-watches-after-checkout.md) Re-arm FileChanged watches after `git checkout` (prototype first) `open` priority:medium. After F12 (re-emission multiplies watch-list cost).
- [ ] [F16](tasks/F16-skill-driver-batching.md) Skill driver: one linter call per tool group and one tsc per tsconfig `open` priority:medium. After F03 and F09 (they remove most of today's cost).

## Stage 3: edge cases and low priority

- [ ] [F18](tasks/F18-overlap-chain-tsc-and-kill-tree.md) Overlap chain lint and tsc; kill the whole process tree on timeout `open` priority:low. Needs the timeout budget re-derived (F29).
- [ ] [F19](tasks/F19-watchlist-skip-generated.md) Keep `linguist-generated` files out of watchPaths `open` priority:low. Needs a user decision. Mostly moot after F04.
- [ ] [F20](tasks/F20-config-walk-readdir.md) One `readdirSync` per directory in the upward config walks (9P) `open` priority:low
- [ ] [F21](tasks/F21-gatefinding-exists-memo.md) Memoize `existsSync` in `gateFinding` `open` priority:low
- [ ] [F22](tasks/F22-filechanged-skip-without-git.md) FileChanged skip without a `git status` spawn (index blob id) `open` priority:low
- [ ] [F23](tasks/F23-superseded-and-duplicate-wakes.md) Superseded and duplicate findings re-wake Claude `open` priority:low. Needs a user decision; the naive staleness check loses findings.
- [ ] [F24](tasks/F24-npm-notice-in-findings.md) Keep "npm notice" lines out of npx-run findings `open` priority:low
- [ ] [F25](tasks/F25-digest-size-bound.md) Bound digest hashing and FileChanged lint by file size `open` priority:low
- [ ] [F26](tasks/F26-per-process-floor-and-hook-filter.md) Per-process floor (about 40 ms) for events the hook cannot act on `open` priority:low
- [ ] [F27](tasks/F27-tests-miss-perf-paths.md) Test the performance-relevant hook paths `open` priority:low. Add each test with the code task it guards.

## Measurement and docs-only

- [ ] [F28](tasks/F28-wsl-windows-path-docs.md) Document the WSL Windows-PATH penalty (mostly inside child processes) `docs-only` priority:medium. Pairs with F11.
- [ ] [F29](tasks/F29-timeout-budget-docs.md) Timeout budget doc: cold Rust leaf crate, SessionStart on 9P `docs-only` priority:low. Re-derive again after F10/F13/F18.
- [ ] [F30](tasks/F30-go-rust-cost-model-docs.md) Document the Go/Rust cost model (scope, cold caches, bursts, gccgo PATH scan) `docs-only` priority:low
- [ ] [F01](tasks/F01-measurement-baseline.md) F01 follow-ups (the harness itself is done, see Done): check whether the repo-explorer-mcp 0.10.3 project pin shadows the user-scope plugin, a burst case (N concurrent hook processes), live `claude -p --debug-file` runs, the `--import` preload for per-subprocess breakdowns `measurement-only` priority:low
- [ ] [F32](tasks/F32-filechanged-echo-race.md) Measure how often the FileChanged echo of Claude's own write beats the digest `measurement-only` priority:low
- [ ] [F33](tasks/F33-watchpaths-size-recheck.md) watchPaths JSON size and watch count need no change; re-check on Claude Code upgrades `measurement-only` priority:low

## Dependencies

- Before each task: re-run `node universal-lint/scripts/perf.mts` (F01, done) for a fresh baseline; each task's Verification compares against it.
- F02 + F03 together remove all false eslint findings seen in this analysis; F02 alone (the safety net) covers projects that have a config but no reachable binary. F04's walk from the file's directory fixes the sub-package case (91 of 128 historical pnpm findings).
- F04 before F09: both rework the npx-fallback branch of `runLintTool`; F04 covers locally installed tools, F09 the npx-cache-only ones (markdown).
- F11's savings and F04's are not additive for JS/TS (0.14.x estimate from the rtk era; rtk is gone since 0.15.0, re-measure in F11); F28 documents the rest.
- F08 (done) shortened the `watchList` loop; F12 still changes the per-file check inside it; F15 and F19 come after F12.
- F10 before F13 (the slot cap bounds the peak; F13 removes redundant work inside it).
- F03 and F09 before F16. F18 and F10/F13 change the timeout budget: update F29's text.
- F27: add each test together with the task it guards (F04, F05, F10, F11, F18).

## Notes

- Finding ids are local to this document set (F01-F33) and unrelated to `dprint/docs` ids; cross-references to dprint say "dprint F24" explicitly.
- Measured, no task:
  - Double plugin install: each debug log reads one hooks.json per plugin id, so the hook cost is not doubled. Whether the repo-explorer-mcp project pin shadows 0.14.0 is unverified (follow-up in the F01 doc).
  - PostToolUse tsc cost grows with project size and with the importer count of the edited file: ts1000 296-335 ms for a leaf edit, 532-1210 ms after an edit to a widely imported module. Accepted under no-debounce. Only F18's overlap reduces wall time; F13 dedups FileChanged only.
- Out of scope (correctness, not perf; track separately): a `.go` file outside any module makes `rtk go vet` print "No issues found" but exit non-zero, and the hook reports that as a finding (exit 2).
- Two verifier corrections to keep in mind: the lstat-only watch-list fast path is NOT semantics-preserving (F12 uses a per-dir realpath cache instead), and dropping a lint as "stale" loses findings after disjoint Edits (F23).
