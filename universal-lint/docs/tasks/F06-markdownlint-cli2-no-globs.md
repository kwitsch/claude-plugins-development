---
id: F06
title: Pass --no-globs to markdownlint-cli2
status: done
priority: medium
area: universal-lint/src/hooks/lint-file.mts (REGISTRY.markdown), universal-lint/tests/markdown.test.mts, universal-lint/tests/registry.test.mts, universal-lint/.claude/rules/line-length-guard.md, universal-lint/.claude/rules/hook-design.md
---

# F06 Pass --no-globs to markdownlint-cli2

## Status

Done in 0.15.5. `REGISTRY.markdown.chain[0]` (markdownlint-cli2) carries the static arg `--no-globs`; classic markdownlint, `buildArgv`, `classifyExit`, `runLintTool` and the skill driver are unchanged. Argv and alternatives: Approach; cli2 version floor: Constraints; cost: hook-design.md "Measured cost", Globs fixture bullet.

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

- [x] Test: `tests/markdown.test.mts` (project-config and npx tests expect `--no-globs` before the file; classic markdownlint never gets it); `tests/registry.test.mts` pins the exact argv with and without a project config.
- [x] Bench (manual, 2026-11-07, numbers in hook-design.md "Measured cost", Globs fixture bullet): header `Linting: 1 file`; the foreign `d1.md` finding no longer surfaces on an `a.md` Write (exit 0); `a2.md` still exits 2 with its own MD041.

## Constraints

Very old cli2 versions on PATH may not know `--no-globs` (npx resolves the current one). Resolved: the flag exists since markdownlint-cli2 0.12.0 (`npm pack` + grep of `markdownlint-cli2.js`: 0.10.0 and 0.11.0 lack it; 0.12.0, 0.12.1 and 0.14.0 have the `--help` line and the `arg === "--no-globs"` handler; npx resolves v0.24.0 with markdownlint v0.42.0, whose `--help` lists it). Probed on 0.11.0 (`npx --yes markdownlint-cli2@0.11.0 --no-globs a.md`): output `Finding: --no-globs a.md`, `Linting: 1 file(s)`, the file's own findings, exit 1, so the flag is read as a glob matching nothing; the file still lints and only the globs suppression is lost. No version gate; noted in `.claude/rules/line-length-guard.md` (the rule that documents the markdownlint argv), not in `languages.md` (no Markdown section, and its `paths` do not load for markdown files or tests). Version bump: 0.15.5.

## Related

F09 (npx cost of the same tool), line-length-guard.md (config handling for markdownlint).

## Measured

Moved verbatim from `.claude/rules/hook-design.md` "Measured cost" (F18, 0.15.15):

- **Globs fixture (F06, manual; `perf.mts` has no such case):** project with `.markdownlint-cli2.jsonc` = `{"globs":["**/*.md"]}`, `docs/d1.md`..`docs/d400.md` (`d1.md` has an MD012 double blank line, the foreign finding), a clean `a.md` and an `a2.md` with its own MD041; markdownlint-cli2 not on PATH, so the hook takes the npx route (warm cache). Label: universal-lint 0.15.4 hook (baseline, built output of `b40176a`) vs 0.15.5, 2026-11-07, WSL2 6.18.33.2-microsoft-standard-WSL2, 12 cores, 9.5 GB, node v24.22.2, markdownlint-cli2 v0.24.0 (markdownlint v0.42.0), PATH 63 dirs / 44 on /mnt/c (load 1.41 -> 1.72 during the run). Medians in ms of 1 warm-up + 5 timed runs. Direct `npx --yes markdownlint-cli2 a.md`: 1121 ms, `Linting: 402 files`; with `--no-globs`: 847 ms, `Linting: 1 file`. Hook, `a.md` Write: 0.15.4 1370 ms (exit 2, foreign `d1.md` finding reported) vs 0.15.5 1090 ms (exit 0, no output); `a2.md` Write: 0.15.4 1352 ms (exit 2) vs 0.15.5 1129 ms (exit 2, own MD041 reported).
