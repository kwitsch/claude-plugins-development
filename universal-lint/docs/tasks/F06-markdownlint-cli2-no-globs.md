---
id: F06
title: Pass --no-globs to markdownlint-cli2
status: done
priority: medium
area: universal-lint/src/hooks/lint-file.mts (REGISTRY.markdown), universal-lint/tests/markdown.test.mts, universal-lint/tests/registry.test.mts, universal-lint/.claude/rules/line-length-guard.md, universal-lint/.claude/rules/hook-design.md
---

# F06 Pass --no-globs to markdownlint-cli2

## Status

Done in 0.15.5. `REGISTRY.markdown.chain[0]` (markdownlint-cli2) carries the static args `["--no-globs"]`, so every single-file markdown lint (PostToolUse Write/Edit, FileChanged, the skill driver) lints only the named file even when a project `.markdownlint-cli2.*` config sets top-level `globs`; the project's rules, `ignores` and `config` still apply. Classic markdownlint (`chain[1]`, still `args: []`), `buildArgv`, `classifyExit`, `runLintTool` and the skill driver are unchanged; the driver (`src/skills/universal-lint/lint-files.mts`) calls `lintFileHandler` per file, so it inherits the argv. Minimum markdownlint-cli2 with the flag: 0.12.0; older versions read it as a glob matching nothing and still lint the file (harmless, no version gate; see Constraints). Tests: `tests/markdown.test.mts` (new: a project `.markdownlint-cli2.jsonc` with top-level `globs` records `markdownlint-cli2 --no-globs <file>`; the npx fallback and project-config argv assertions expect `--no-globs`; classic markdownlint never gets it), `tests/registry.test.mts` (both markdownlint-cli2 `buildArgv` tests expect `--no-globs` first). Measured on a 400-file globs fixture: see the Bench line under Verification (also in hook-design.md "Measured cost", Globs fixture bullet).

## Problem

markdownlint-cli2 merges the top-level `globs` of a project `.markdownlint-cli2.*` config with the file argument. In such projects every single-file hook lints every markdown file in the repo: cost grows with repo size, and issues in other files come back as foreign (reportable) findings on every .md edit.

## Evidence

Fixture with 400 .md files and `{"globs":["**/*.md"]}`: cli2 v0.24.0 header `Finding: docs/d1.md **/*.md / Linting: 400 files`, direct run 543-675 ms vs 242-299 ms with `--no-globs` (`Linting: 1 file`). Hook median 1331 ms vs about 1137 ms for a single-file project. No `.markdownlint-cli2.*` config exists in ~/repos (setup-specific). `markdownlint-cli2 --help` (v0.24.0) documents `--no-globs`.

## Code locations

`REGISTRY.markdown` chain entry `{ name: "markdownlint-cli2", args: [] }`; `buildArgv` (appends `--config` only without a project config).

## Approach

Shipped: the markdownlint-cli2 entry of `REGISTRY.markdown` has the static args `["--no-globs"]` with a one-line why-comment. `buildArgv` already starts from `tool.args.slice()`, so the argv is `--no-globs`, then `--config <MD013-off file>` only without a project markdownlint config, then the file; the PATH, local `node_modules/.bin` and `npx --yes markdownlint-cli2` routes share it (npx passes args after the package name to the bin). The flag drops only the config's top-level `globs`; the project's rules, `ignores`, `gitignore` and `config` still apply. Classic markdownlint (`markdownlint-cli` 0.x) has no globs option and keeps `args: []`: an unknown flag could make it fail, which `classifyExit` buckets as skip and would silently disable the fallback. No cache is keyed on `args` (`probeCache` is keyed by tool name). Not taken: a `noGlobs` field on `LintTool` or a tool-name branch in `buildArgv` (more code, same behaviour, against the registry-driven design); an own `--config` without `globs` (it replaces the project config for the run, breaking "a project's own config always wins"); a `markdownlint-cli2 --version` probe gating the flag (a spawn per event, more than the saving on small repos, for a harmless degradation on cli2 < 0.12.0); a temp cwd or environment override (cli2 resolves the config by walking up from the file, so it would still apply).

## Verification

Test: the markdownlint-cli2 stub records `--no-globs` before the file argument. Bench on the globs fixture: header reads `Linting: 1 file`; a foreign issue in another .md no longer surfaces.

- [x] Test: `tests/markdown.test.mts` "markdown: project .markdownlint-cli2.jsonc with top-level globs -> --no-globs precedes the file (a single-file lint, not the project's globs)" records exactly `markdownlint-cli2 --no-globs <file>`; `tests/registry.test.mts` expects `["--no-globs", "--config", <cfg>, <file>]` without and `["--no-globs", <file>]` with a project config.
- [x] Bench (manual, 2026-11-07, numbers in hook-design.md "Measured cost", Globs fixture bullet): direct cli2 `Linting: 402 files` 1121 ms -> `Linting: 1 file` 847 ms with `--no-globs`; hook `a.md` Write 1370 ms, exit 2, foreign `d1.md` finding reported (0.15.4) -> 1090 ms, exit 0, no output (0.15.5); `a2.md` Write still exits 2 with its own MD041 reported.

## Constraints

Very old cli2 versions on PATH may not know `--no-globs` (npx resolves the current one). Resolved: the flag exists since markdownlint-cli2 0.12.0 (`npm pack` + grep of `markdownlint-cli2.js`: 0.10.0 and 0.11.0 lack it; 0.12.0, 0.12.1 and 0.14.0 have the `--help` line and the `arg === "--no-globs"` handler; npx resolves v0.24.0 with markdownlint v0.42.0, whose `--help` lists it). Probed on 0.11.0 (`npx --yes markdownlint-cli2@0.11.0 --no-globs a.md`): output `Finding: --no-globs a.md`, `Linting: 1 file(s)`, the file's own findings, exit 1, so the flag is read as a glob matching nothing; the file still lints and only the globs suppression is lost. No version gate; noted in `.claude/rules/line-length-guard.md` (the rule that documents the markdownlint argv), not in `languages.md` (no Markdown section, and its `paths` do not load for markdown files or tests). Version bump: 0.15.5.

## Related

F09 (npx cost of the same tool), line-length-guard.md (config handling for markdownlint).
