---
id: F37
title: hook-design.md is over the 40,000-character rule limit
status: done
priority: low
area: universal-lint/.claude/rules/hook-design.md (docs)
---

## Status

Done in 0.16.1. Found by [EVALUATION-2026-11-14](../EVALUATION-2026-11-14.md) (docs drift check). Docs only, no code change.

## Problem

The repo keeps every `.claude/rules/*.md` file under 40,000 characters ("the on-demand load limit", root `CLAUDE.md`; F01 Constraints: "Keep hook-design.md under 40,000 characters"). F34's "Settle window (F34, 0.16.0)" section and its additions to the other sections took `universal-lint/.claude/rules/hook-design.md` over it. The rule loads for every file under `src/hooks/**`, `plugin/hooks/**`, several tests and `scripts/perf.mts`, so each of those sessions pays the extra context. In the 2026-11-14 session the whole file was still loaded (no truncation seen), so the cost is the broken repo rule and context size, not lost text.

## Evidence

`wc -m universal-lint/.claude/rules/hook-design.md`: 42,361 characters at 0.16.0 (HEAD `cdc9421`); 36,010 at 0.15.30 (`7ad8ac8`). The other rule files of the plugin: languages.md 13,023 bytes, typescript-check.md 4,642, line-length-guard.md 3,681, skill-driver.md 3,000, tests.md 2,475.

## Code locations

None. `universal-lint/.claude/rules/hook-design.md` (frontmatter `paths:` and sections "Settle window (F34, 0.16.0)", "File detection", "Measured cost"); `universal-lint/CLAUDE.md` "Parts" lists the rule files.

## Approach

Move the "Settle window (F34, 0.16.0)" section (about 6,000 characters) into its own path-scoped rule, e.g. `universal-lint/.claude/rules/settle-window.md` with the same `paths:` plus `tests/settle*.test.mts`, and leave a one-line pointer in hook-design.md; add the new file to `universal-lint/CLAUDE.md` "Parts". Alternatively shorten the "Measured cost" pointers into `docs/README.md`. Keep every rule moved verbatim (no behaviour text lost), and keep each file under 40,000 characters.

## Verification

`wc -m` of every file in `universal-lint/.claude/rules/` below 40,000; the moved text is unchanged (diff of the section); `dprint check` and markdownlint clean on the touched files.

## Constraints

Docs only. Do it before or together with F35/F36, which touch the same section. Any change under `universal-lint/` merged to `main` needs a version bump (root CLAUDE.md), so ship it with F35 or F36 or bump the patch version.

## Related

F01 (Constraints), F34 (added the section), F35, F36.

## Verification result

Shipped in 0.16.1: the "Settle window (F34, 0.16.0)" section moved verbatim to `.claude/rules/settle-window.md` (paths: `src/hooks/**`, `plugin/hooks/**`, `tests/settle*.test.mts`), pointer left in hook-design.md, `CLAUDE.md` "Parts" updated. `wc -m`: hook-design.md 36,717 (was 42,336), settle-window.md 5,846.
