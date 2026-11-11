---
id: F03
title: Skip the eslint chain when no eslint/oxlint config exists
status: done
priority: high
area: universal-lint/src/hooks/lint-file.mts (resolveOxlintConfig, runChainLint, lintResolved, ESLINT_CONFIG_FILENAMES), universal-lint/.claude/rules/languages.md
---

# F03 Skip the eslint chain when no eslint/oxlint config exists

## Status

Done in 0.15.2. Shipped: a no-config branch in `lintResolved`: a JS/TS file whose `resolveOxlintConfig(fileDir, cwd)` is null runs `REGISTRY.jsts` (eslint) only when an eslint config name (`ESLINT_CONFIG_FILENAMES`) exists from the file's dir up to `/`, walked through `walkToRoot` (the walker of `hasProjectMarkdownlintConfig`); otherwise no chain lint runs (no PATH probe, no `npx --yes eslint`), and `tsc` still runs for `.ts`/`.tsx`/`.mts`/`.cts`. `resolveOxlintConfig` is unchanged (signature, body and its 7 registry tests). Tests (`tests/oxlint.test.mts`): no config anywhere spawns nothing with eslint, oxlint and npx stubs present; a `.ts` file without a config still spawns tsc and no eslint or npx; an `eslint.config.mjs` in cwd and exactly one level above cwd still runs eslint; six existing tests in `npx-fallback`, `core` and `tsc` that relied on "no config = eslint" got an explicit `eslint.config.mjs`. User decision: the documented rule "No config at all = eslint" (languages.md) became "no eslint and no oxlint config = no JS/TS chain lint", with the eslint-name walk unbounded up to `/` so a monorepo-root or `$HOME` eslint config above cwd still runs eslint. Departure from the Approach: `package.json#eslintConfig` is not a config signal: the hook runs PATH eslint or `npx --yes eslint` (eslint 10), and eslint 9 and later ignore the key, so such a run exits 2 (skip); selection stays name-only per languages.md. Accepted: legacy `.eslintrc*` names count by name, but eslint 10 ignores them and exits 2 (skip), so such a project still pays that run (unchanged from 0.15.1). Measured with `node universal-lint/scripts/perf.mts 5`, medians in ms, before (0.15.1) -> after (0.15.2), same machine and session: `.ts Write (no eslint config)` real PATH 859 -> 128, no /mnt 799 -> 136; `.ts Edit (no eslint config)` real PATH 905 -> 136, no /mnt 786 -> 132.

## Problem

`resolveOxlintConfig` already walks from the file's directory to cwd over every oxlint and eslint config name, but returns null both for "eslint config found" and for "no config at all"; both cases run `REGISTRY.jsts` (eslint). eslint 10 (what npx resolves) exits 2 without a config, which `classifyExit` treats as skip. So every .ts/.tsx/.mts/.js edit in a project without a lint config pays an rtk probe plus `rtk lint`/npx eslint for a result that is always thrown away, and on a cold npx cache it produces F02's false finding.

## Evidence

- ts300, no lint config, warm cache: Write 1318 ms, Edit 1194 ms (N=7). `rtk lint src/m150.ts` alone 825-912 ms, exit 2 (skip). With eslint unreachable (PATH = node+tsc+rtk+git) the same Edit takes 344 ms: about 850 ms (about 70%) wasted per TS edit.
- CPU of `rtk lint` alone: 0.9 s real, 0.67 s user, 0.25 s sys.
- ts5/ts300/ts1000 traces: rtk lint 780-990 ms, status 2, in every run, out of 1269-1623 ms total. Skill driver over 10 ts300 files: 10.0 s of 12.7 s is rtk lint.
- Fixture without pnpm and without config: `rtk lint` 793-798 ms, rc 2, up to about 3 s on the first call.

## Code locations

- `resolveOxlintConfig` (make it report the kind: oxlint config path | eslint | none)
- `runChainLint` (selects `REGISTRY.jsts` when the result is null), `lintResolved` (tsc still runs for TS files)
- `ESLINT_CONFIG_FILENAMES`, `OXLINT_CONFIG_FILENAMES`, `walkUpToCwd`, `walkToRoot`

## Approach

Shipped without the tri-state return: `resolveOxlintConfig` already separates "the nearest config within cwd is an oxlint config" (its path) from everything else (null). In the null case the nearest config within fileDir..cwd is either an eslint name or nothing, and one `walkToRoot` over `ESLINT_CONFIG_FILENAMES` from the file's dir to `/` tells the two apart: it re-finds an eslint config within cwd and also finds one above cwd (eslint's own lookup goes past the project root too). Only when it finds nothing is `runChainLint` skipped; `oxlintRan` stays false, so the tsc gate still runs `runTypeCheck` for TS files. The tri-state return would have saved at most (depth + 1) x 12 `existsSync` calls (microseconds on ext4) at the price of a new union type, a changed exported contract with its 7 registry tests and a path-returning root walker; F20 reworks these walks anyway. Legacy `.eslintrc*` names were already in `ESLINT_CONFIG_FILENAMES`; no `package.json` is read (see Status). The rtk mentions in Problem and Evidence describe 0.14.x: rtk support was removed in 0.15.0, so the waste left in 0.15.1 was the PATH or `npx --yes eslint` run that exits 2 (skip) after about 0.8 s.

## Verification

Run: `pnpm --filter universal-lint build && pnpm --filter universal-lint test && pnpm lint` (the new and updated hook tests named in Status; the `resolveOxlintConfig` registry tests unchanged and green), and `node universal-lint/scripts/perf.mts 5` once on the 0.15.1 build before the change and once on the 0.15.2 build after it (numbers in Status; the after-run is the "Measured cost" table in `.claude/rules/hook-design.md`). The original target "ts300 Edit from about 1200 ms to about 350 ms" was measured on the ts300 fixture (rtk era), not on the harness fixture (a 30-line `a.ts`); the comparison of record is the harness before/after.

## Constraints

Behaviour change of a documented rule: confirm with the user and update languages.md. Keep the oxlint-wins-same-dir rule and name-only selection. No `userConfig`. Version bump.

## Related

F02 (done; obsolete since rtk was removed in 0.15.0), F16 (skill driver cost), F04.
