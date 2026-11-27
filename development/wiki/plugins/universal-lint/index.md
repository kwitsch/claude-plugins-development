# universal-lint knowledge

Working documents for agent sessions. Not shipped (`plugin/` is the installable part), not user documentation. Language: English. The F01-F33 performance run is finished (0.15.1-0.15.29 plus the 0.15.30 closure), F34 shipped in 0.16.0; the evaluation of 2026-11-14 ([EVALUATION-2026-11-14.md](evaluations/EVALUATION-2026-11-14.md)) opened F35-F37, shipped in 0.16.1; the second one of that day ([EVALUATION-2026-11-14-v0.16.1.md](evaluations/EVALUATION-2026-11-14-v0.16.1.md), on 0.16.1) opened F38-F39. 0.18.0 (mod plus MCP server) was checked live in [EVALUATION-2026-11-26-v0.18.0.md](evaluations/EVALUATION-2026-11-26-v0.18.0.md). `TASKS.md` is the index.

## Pages

- [CLAUDE.md](../../../../universal-lint/CLAUDE.md): the plugin's overview and rule list (loads with the plugin's files).
- [TASKS.md](TASKS.md): task list; `tasks/` holds one document per task. Start here for open work.
- [evaluations/EVALUATION-2026-11-26-v0.18.0.md](evaluations/EVALUATION-2026-11-26-v0.18.0.md): evaluation: universal-lint evaluation 2026-11-26b (plugin 0.18.0): local gate and the live checks L2-L12 under the managed policy with ruff
- [evaluations/EVALUATION-2026-11-26-mod-server.md](evaluations/EVALUATION-2026-11-26-mod-server.md): evaluation: universal-lint evaluation 2026-11-26: mod plus MCP server instead of six command hooks (preparation, no code change)
- [evaluations/EVALUATION-2026-11-14-v0.16.1.md](evaluations/EVALUATION-2026-11-14-v0.16.1.md): evaluation: universal-lint evaluation 2026-11-14b (plugin 0.16.1)
- [evaluations/EVALUATION-2026-11-14.md](evaluations/EVALUATION-2026-11-14.md): evaluation: universal-lint evaluation 2026-11-14 (plugin 0.16.0)
- [design/edit-range-gate.md](design/edit-range-gate.md): design: Edit-range gate (do not "fix" without reading this)
- [design/file-detection.md](design/file-detection.md): design: File detection: FileChanged + watch list (do not "fix" without reading this)
- [design/hook-design.md](design/hook-design.md): design: Hook design: the 0.18.0 surface (mod, one MCP server per session, `mcp_tool` hooks, session key, the reversal of 2026-11-06), the earlier command-hook state, timeout budget and measured cost
- [design/lang-css.md](design/lang-css.md): design: CSS/SCSS: stylelint
- [design/lang-go.md](design/lang-go.md): design: Go: golangci-lint/go vet, package scope, and cold GOCACHE
- [design/lang-jsts.md](design/lang-jsts.md): design: JS/TS: eslint vs oxlint
- [design/lang-php.md](design/lang-php.md): design: PHP: phpstan/psalm and the vendor/bin gap
- [design/lang-rust.md](design/lang-rust.md): design: Rust: cargo clippy/check, manifest targeting, and the clippy-component gap
- [design/languages.md](design/languages.md): design: JSON: not covered (do not "fix" without reading this)
- [design/line-length-guard.md](design/line-length-guard.md): design: YAML/Markdown line-length guard (do not "fix" without reading this)
- [design/npx-and-local-bin.md](design/npx-and-local-bin.md): design: Local `node_modules/.bin`, npx fallback, PATH probe cache (do not "fix" without reading this)
- [design/settle-window.md](design/settle-window.md): design: Settle window and owner routing (F34 0.16.0, rebuilt by F40 0.17.0; journal in memory and the delivery matrix since 0.18.0)
- [design/typescript-check.md](design/typescript-check.md): design: TypeScript type-checking (`tsc`)

## What shipped

All of F01-F33 shipped or were closed docs-only in universal-lint 0.15.1-0.15.29; F02, F14, F17 and F31 became obsolete when rtk support was removed in 0.15.0; 0.15.30 is the final verification and docs pass with no code change. Per-task version, kind and summary: [TASKS.md](TASKS.md).

## How to work a task

See [how-to-work-a-task.md](../how-to-work-a-task.md).

## Task conventions

- Pick by stage order, then priority, among tasks whose dependencies (`TASKS.md`) are done.
- Read the rule `universal-lint/.claude/rules/lint-file.md` (the constraints) and the design pages in `design/` for the areas the task touches, at least `design/hook-design.md` (fail-open contract, timeout budget), `design/edit-range-gate.md`, `design/file-detection.md`, `design/npx-and-local-bin.md` and `design/languages.md` with the `lang-*.md` page of the language the task touches. Several tasks touch documented user decisions (the task says so under `Constraints`): ask before changing one.
- The code is in `src/hooks/lint-core.ts` (the library; the entries are `src/mcp/server.ts`, `src/hooks/watch-paths.ts` and `src/skills/universal-lint/lint-files.ts`, and the mod is `src/hooks/register.ts`; the handlers of the server are in `src/mcp/handlers.ts`) unless the task says otherwise. Re-measure the baseline numbers the task cites (see F01) before and after the change; they are from one machine and one day.
- Update the design page in `design/` that documents the changed behaviour. A new or changed constraint also gets its one line in `universal-lint/.claude/rules/lint-file.md`; reasons, numbers and residuals stay in the design page.

## Conventions

- Fail open everywhere in the hook path: every guard failure, skip, missing tool, timeout or internal error ends with no output and exit `0` (at most a one-line `universal-lint: …` note on stderr, as the watch-list limit and the FileChanged slot give-up write; exit 0 never wakes Claude). Only real findings produce the `universal-lint…: …` text on stderr with exit `2` (asyncRewake). A false finding is worse than a missed one, because it wakes Claude.
- Linting never modifies the user's files or repo (no `--fix`, no installs into the project tree). Cross-event state lives in the session's server process since 0.18.0 (Maps, bounded by `capSet`; see `design/hook-design.md` "Surface"); the remaining file state goes under `${CLAUDE_PLUGIN_DATA || os.tmpdir()}` only, written atomically (temp file + `renameSync`, as the npx refresh stamp does), and an unreadable cache means "probe again".
- No debounce for Write/Edit (user decision 2026-11-06, kept): every Write/Edit lints right away, in the session's server. No `userConfig` (permanent). One MCP server per session (decision 2026-11-26, reversing the 2026-11-06 command-hooks decision; reasons in `design/hook-design.md` "Surface").
- Runtime code stays zero-dependency Node (`node:` builtins only). New symbols get TSDoc (`.claude/rules/tsdoc.md` at the repo root).

## Where measurements live

- Original 0.14.0 analysis: the `TASKS.md` header and each task's Evidence section.
- Before/after numbers of a change: that task's Status or "Measured" section.
- Current baseline: `tasks/F01-measurement-baseline.md`, "Measured" (0.15.29 medians, machine label); 0.16.0 medians, the 0.15.30 A/B and the settle-window costs (hold, journal, digests, bursts): `EVALUATION-2026-11-14.md`; 0.16.1 medians, the F35/F36 effect, the precheck cost and bursts with an own-line finding per file: `EVALUATION-2026-11-14-v0.16.1.md`.
- Harness and live-hook recipe: `design/hook-design.md`, "Measured cost".
- Final verification of 0.15.30: 321 tests pass, `pnpm lint` exit 0, `claude plugin validate` passes (non-blocking ICON_MISSING warning, pre-existing), all 16 `perf.ts` cases ok; the table is the F01 "Measured" section.

## Re-check recipes (Claude Code or toolchain upgrades)

- F33, watchPaths count and size: on a Claude Code upgrade rerun the recipe in the F33 Approach (`tasks/F33-watchpaths-size-recheck.md`). Signal: the `watching` count differs from the path count, or the line is missing.
- F15, re-arm after checkout: rerun the prototype in `tasks/F15-rearm-watches-after-checkout.md` "Prototype harness" on a new Claude Code version (it was 2.1.319); the upstream report text is in that doc's "Upstream report (ready to file)".
- F28, the WSL Windows-PATH penalty: reopen trigger as written in `tasks/F28-wsl-windows-path-docs.md` "Status": Go edits become a measured budget problem, and `GCCGO`/`GOFLAGS` are readable without an extra spawn.
