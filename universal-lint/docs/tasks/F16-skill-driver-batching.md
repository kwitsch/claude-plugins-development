---
id: F16
title: "Skill driver: one linter call per tool group and one tsc per tsconfig"
status: open
priority: medium
area: universal-lint/src/skills/universal-lint/lint-files.mts (top-level loop, mkArgs), universal-lint/src/hooks/lint-file.mts (lintFileHandler, lintResolved, runChainLint, buildArgv, runTypeCheck, scopedTarget roots), universal-lint/.claude/rules/skill-driver.md
---

# F16 Skill driver: batch per tool group, tsc once per tsconfig

## Status

Open. Merges static driver-batching finding (confirmed, medium), bench-js-ts driver finding (confirmed, low: tsc rerun per file) and the static roots finding (confirmed, low: realpath of cwd per file). The driver's `shortcut:` comment already accepts the per-file tsc rerun "only if a large .ts batch ever bites".

## Problem

The driver calls `lintFileHandler` per file: one linter spawn (and one npx startup) per file, a whole-project tsc per .ts file, and, through the default `postToolScope`, `scopedTarget` without `roots`, so `realish(cwd)` runs per file. Every registered linter accepts multiple files, and the driver lints whole files (no gate) and aggregates one report anyway. In-process the probe caches do hit (2 probes per run).

## Evidence

- 10 .md (this repo): 13,981 ms vs one `npx --yes markdownlint-cli2 <10 files>` 1,139 ms, direct batched 381 ms. 6 .md: 7,945 vs 982 (npx) vs 279 ms (direct).
- 10 .mts: 11,494 ms (10 npx, 10 failed `rtk oxlint`) vs one batched direct oxlint 247 ms (single file 202 ms).
- 10 ts300 files: 12,666 ms = rtk lint 10× 10,029 ms + rtk tsc 10× 2,376 ms.
- `scopedTarget` per call: 73-96 ms on 9P at depth 9-10, about 0.1 ms on ext4.

## Code locations

lint-files.mts loop `for (const p of paths) { lintFileHandler(mkArgs(resolved)) }` and its `shortcut:` comment; `lintFileHandler(args, scoped = postToolScope(args))`; `scopedTarget(cwd, file, scratchpad?, roots?)`; `lintResolved`, `runChainLint`, `buildArgv` (single target appended last), `runTypeCheck`.

## Approach

Step 0 (cheap, do anyway): compute `roots = { cwd: realpath(cwd) }` once in the driver and pass `scopedTarget(cwd, p, undefined, roots)` as `lintFileHandler`'s second argument. Step 1: export a batch entry from lint-file.mts that groups scoped files by (language entry, resolved config: oxlint `-c`, markdownlint/yamllint guard config, Go package dir, Cargo manifest), calls `buildArgv` with N targets per group, and runs tsc once per resolved tsconfig (memo keyed by tsconfig path). Classification per group; report labelled per group. Many of today's costs vanish with F03 (no-config eslint) and F09 (npx), so measure after those.

## Verification

skill.test.mts: a 3-file list records one linter invocation with 3 targets and one tsc call per tsconfig. Bench: 10 .md ≤ about 1.5 s (≤ 0.5 s with F09), 10 .mts ≤ about 1 s, 10 ts300 files ≈ 0.3 s + chain. Hook per-event behaviour unchanged (existing tests).

## Constraints

Driver stays read-only and reuses the hook's registry/argv/classifier ("no new linting logic", skill-driver.md). Per-file fail-open stays. Same scope semantics. Version bump.

## Related

F03, F09, F04, F13 (same dedup idea for FileChanged bursts).
