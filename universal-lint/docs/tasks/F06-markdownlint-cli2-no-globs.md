---
id: F06
title: Pass --no-globs to markdownlint-cli2
status: open
priority: medium
area: universal-lint/src/hooks/lint-file.mts (REGISTRY.markdown, buildArgv)
---

# F06 Pass --no-globs to markdownlint-cli2

## Status

Open. bench-other-langs finding (adjusted: high → medium; specific setup). One-line change.

## Problem

markdownlint-cli2 merges the top-level `globs` of a project `.markdownlint-cli2.*` config with the file argument. In such projects every single-file hook lints every markdown file in the repo: cost grows with repo size, and issues in other files come back as foreign (reportable) findings on every .md edit.

## Evidence

Fixture with 400 .md files and `{"globs":["**/*.md"]}`: cli2 v0.24.0 header `Finding: docs/d1.md **/*.md / Linting: 400 files`, direct run 543-675 ms vs 242-299 ms with `--no-globs` (`Linting: 1 file`). Hook median 1331 ms vs about 1137 ms for a single-file project. No `.markdownlint-cli2.*` config exists in ~/repos (setup-specific). `markdownlint-cli2 --help` (v0.24.0) documents `--no-globs`.

## Code locations

`REGISTRY.markdown` chain entry `{ name: "markdownlint-cli2", args: [] }`; `buildArgv` (appends `--config` only without a project config).

## Approach

Set the markdownlint-cli2 entry's static args to `["--no-globs"]` (classic markdownlint has no globs option). The project's own config and ignores still apply. markdownlint-cli2 has no rtk verb, so the rtk path is unaffected; the static args become part of the rtk probe key, which is harmless.

## Verification

Test: the markdownlint-cli2 stub records `--no-globs` before the file argument. Bench on the globs fixture: header reads `Linting: 1 file`; a foreign issue in another .md no longer surfaces.

## Constraints

Very old cli2 versions on PATH may not know `--no-globs` (npx resolves the current one); check the oldest version that supports it and note it in languages.md if it matters. Version bump.

## Related

F09 (npx cost of the same tool), line-length-guard.md (config handling for markdownlint).
