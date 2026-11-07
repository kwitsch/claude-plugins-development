---
id: F03
title: Skip the eslint chain when no eslint/oxlint config exists
status: open
priority: high
area: universal-lint/src/hooks/lint-file.mts (resolveOxlintConfig, runChainLint, lintResolved, ESLINT_CONFIG_FILENAMES), universal-lint/.claude/rules/languages.md
---

# F03 Skip the eslint chain when no eslint/oxlint config exists

## Status

Open. bench-js-ts finding 2 (confirmed, high) plus the config-gate part of the real-sessions eslint finding. Behaviour change against documented behaviour ("No config at all = eslint (pre-oxlint behavior)", languages.md), so the docs must change with it.

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

Let the existing walk return "none" separately and skip the chain lint for "none" (tsc still runs for TS). To not lose configs eslint itself would find, continue the eslint-name walk past cwd to the filesystem root (`walkToRoot`; measured about 47 `existsSync` calls, under 1.5 ms on ext4) and also accept legacy `.eslintrc*` names and a `package.json` `eslintConfig` key (name and key presence only; no config parsing beyond that one JSON read). Update languages.md: no config anywhere = no JS/TS chain lint.

## Verification

Test: a jsts file without any config, with an npx stub and an rtk stub: no npx/rtk call recorded, exit 0; a TS file still gets tsc. With `eslint.config.mjs` (in cwd and in a parent above cwd) eslint still runs. Existing oxlint/eslint selection tests (oxlint-wins-same-dir tie) stay green. Bench: ts300 Edit from about 1200 ms to about 350 ms with no `rtk lint`/npx in the trace.

## Constraints

Behaviour change of a documented rule: confirm with the user and update languages.md. Keep the oxlint-wins-same-dir rule and name-only selection. No `userConfig`. Version bump.

## Related

F02 (false finding in no-config projects disappears), F16 (skill driver cost), F04.
