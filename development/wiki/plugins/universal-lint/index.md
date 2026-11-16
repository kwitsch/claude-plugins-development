# universal-lint knowledge (for Claude sessions)

Working documents for agent sessions. Not shipped (`plugin/` is the installable part), not user documentation. Language: English. The F01-F33 performance run is finished (0.15.1-0.15.29 plus the 0.15.30 closure), F34 shipped in 0.16.0; the evaluation of 2026-11-14 ([EVALUATION-2026-11-14.md](EVALUATION-2026-11-14.md)) opened F35-F37, shipped in 0.16.1; the second one of that day ([EVALUATION-2026-11-14b.md](EVALUATION-2026-11-14b.md), on 0.16.1) opened F38-F39. `TASKS.md` is the index.

## Pages

- [CLAUDE.md](../../../../universal-lint/CLAUDE.md): the plugin's overview and rule list (loads with the plugin's files).
- [TASKS.md](TASKS.md): task list; `tasks/` holds one document per task. Start here for open work.
- [EVALUATION-2026-11-14.md](EVALUATION-2026-11-14.md): universal-lint evaluation 2026-11-14 (plugin 0.16.0)
- [EVALUATION-2026-11-14b.md](EVALUATION-2026-11-14b.md): universal-lint evaluation 2026-11-14b (plugin 0.16.1)
- [design/edit-range-gate.md](design/edit-range-gate.md): Edit-range gate (do not "fix" without reading this)
- [design/file-detection.md](design/file-detection.md): File detection: FileChanged + watch list (do not "fix" without reading this)
- [design/hook-design.md](design/hook-design.md): Hook design (do not "fix" without reading this)
- [design/lang-css.md](design/lang-css.md): CSS/SCSS: stylelint
- [design/lang-go.md](design/lang-go.md): Go: golangci-lint/go vet, package scope, and cold GOCACHE
- [design/lang-jsts.md](design/lang-jsts.md): JS/TS: eslint vs oxlint
- [design/lang-php.md](design/lang-php.md): PHP: phpstan/psalm and the vendor/bin gap
- [design/lang-rust.md](design/lang-rust.md): Rust: cargo clippy/check, manifest targeting, and the clippy-component gap
- [design/languages.md](design/languages.md): JSON: not covered (do not "fix" without reading this)
- [design/line-length-guard.md](design/line-length-guard.md): YAML/Markdown line-length guard (do not "fix" without reading this)
- [design/npx-and-local-bin.md](design/npx-and-local-bin.md): Local `node_modules/.bin`, npx fallback, PATH probe cache (do not "fix" without reading this)
- [design/settle-window.md](design/settle-window.md): Settle window and owner routing (F34 0.16.0, rebuilt by F40 0.17.0)
- [design/typescript-check.md](design/typescript-check.md): TypeScript type-checking (`tsc`)

## What shipped

All of F01-F33 shipped or were closed docs-only in universal-lint 0.15.1-0.15.29; F02, F14, F17 and F31 became obsolete when rtk support was removed in 0.15.0; 0.15.30 is the final verification and docs pass with no code change. Per-task version, kind and summary: [TASKS.md](TASKS.md).

## How to work a task

1. Pick the first open task from "Remaining" in `TASKS.md` (stage order, then priority) whose dependencies are done. Read its detail document plus the documents under its `Related` section.
2. Read `universal-lint/CLAUDE.md`, the rule `universal-lint/.claude/rules/lint-file.md` (the constraints) and the design pages in `design/` for the areas the task touches, at least `design/hook-design.md` (fail-open contract, timeout budget), `edit-range-gate.md`, `file-detection.md`, `npx-and-local-bin.md` and `languages.md` with the `lang-*.md` page of the language the task touches. Several tasks touch documented user decisions; the task says so under `Constraints`. Ask before changing one.
3. Locate code by the symbol names in `Code locations` (`src/hooks/lint-file.ts` unless stated otherwise); line numbers are deliberately absent because they drift.
4. Re-measure the baseline numbers the task cites (see F01) before and after the change. The numbers in these documents are from one machine and one day.
5. Implement in `src/`, add the tests named under `Verification`, then run `pnpm --filter universal-lint build && pnpm --filter universal-lint test && pnpm lint`. Never edit `plugin/**/*.mjs` or `plugin/.claude-plugin/plugin.json` by hand.
6. Any change under `universal-lint/` merged to `main` needs a version bump: `version` in `universal-lint/package.json` (the only manifest source), then `pnpm --filter universal-lint build`.
7. Update the design page in `design/` that documents the changed behaviour (usually `hook-design.md`, one of the pages split from it, or a `lang-*.md`). A new or changed constraint also gets its one line in `universal-lint/.claude/rules/lint-file.md`; reasons, numbers and residuals stay in the design page.
8. Update the task: set `status` in its frontmatter, adjust `Status`/`Approach` to what shipped, and update its `TASKS.md` entry (checkbox, section, status tag: `.claude/rules/plugin-docs-tasks.md`).

## Conventions

- Fail open everywhere in the hook path: every guard failure, skip, missing tool, timeout or internal error ends with no output and exit `0` (at most a one-line `universal-lint: …` note on stderr, as the watch-list limit and the FileChanged slot give-up write; exit 0 never wakes Claude). Only real findings produce the `universal-lint…: …` text on stderr with exit `2` (asyncRewake). A false finding is worse than a missed one, because it wakes Claude.
- Linting never modifies the user's files or repo (no `--fix`, no installs into the project tree). Persistent plugin state goes under `${CLAUDE_PLUGIN_DATA || os.tmpdir()}` only, written atomically (temp file + `renameSync`, as `recordWritten` does and the PATH probe store `probe-<hashPath(PATH)>.json` (F11); FileChanged slot files (`fc-slots/`) are the exception: claimed by an exclusive `wx` create holding the pid, see `development/wiki/plugins/universal-lint/design/file-detection.md` "Slot cap"), and an unreadable cache means "probe again".
- No debounce for Write/Edit (user decision 2026-11-06): every Write/Edit lints right away in its own process. No `userConfig` (permanent). Command hooks, no MCP server (user decision 2026-11-06).
- Runtime code stays zero-dependency Node (`node:` builtins only). New symbols get TSDoc (`.claude/rules/tsdoc.md` at the repo root).

## Where measurements live

- Original 0.14.0 analysis: the `TASKS.md` header and each task's Evidence section.
- Before/after numbers of a change: that task's Status or "Measured" section.
- Current baseline: `tasks/F01-measurement-baseline.md`, "Measured" (0.15.29 medians, machine label); 0.16.0 medians, the 0.15.30 A/B and the settle-window costs (hold, journal, digests, bursts): `EVALUATION-2026-11-14.md`; 0.16.1 medians, the F35/F36 effect, the precheck cost and bursts with an own-line finding per file: `EVALUATION-2026-11-14b.md`.
- Harness and live-hook recipe: `design/hook-design.md`, "Measured cost".
- Final verification of 0.15.30: 321 tests pass, `pnpm lint` exit 0, `claude plugin validate` passes (non-blocking ICON_MISSING warning, pre-existing), all 16 `perf.mts` cases ok; the table is the F01 "Measured" section.

## Re-check recipes (Claude Code or toolchain upgrades)

- F33, watchPaths count and size: on a Claude Code upgrade rerun the recipe in the F33 Approach (`tasks/F33-watchpaths-size-recheck.md`). Signal: the `watching` count differs from the path count, or the line is missing.
- F15, re-arm after checkout: rerun the prototype in `tasks/F15-rearm-watches-after-checkout.md` "Prototype harness" on a new Claude Code version (it was 2.1.319); the upstream report text is in that doc's "Upstream report (ready to file)".
- F28, the WSL Windows-PATH penalty: reopen trigger as written in `tasks/F28-wsl-windows-path-docs.md` "Status": Go edits become a measured budget problem, and `GCCGO`/`GOFLAGS` are readable without an extra spawn.
