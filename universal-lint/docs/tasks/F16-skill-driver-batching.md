---
id: F16
title: "Skill driver: one linter call per tool group and one tsc per tsconfig"
status: done
priority: medium
area: universal-lint/src/skills/universal-lint/lint-files.mts (top-level loop, mkArgs), universal-lint/src/hooks/lint-file.mts (lintFileHandler, lintResolved, runChainLint, buildArgv, runTypeCheck, scopedTarget roots), universal-lint/.claude/rules/skill-driver.md
---

# F16 Skill driver: batch per tool group, tsc once per tsconfig

## Status

Done in 0.15.14. `lintFilesHandler` (`src/hooks/lint-file.mts`) is the driver's batch entry: it scopes every listed file once against one `realish(cwd)`, plans each with the hook's own resolution (`chainEntryFor`, `planChainLint`, extracted verbatim from `lintResolved`/`runChainLint` in a separate commit), runs each chain tool once per group of files sharing tool, local bin, spawn cwd and argv prefix (go/cargo once per package dir / crate; at most `BATCH_MAX_FILES` = 100 files per spawn), classifies with `chainOutcome`, and runs tsc once per resolved tsconfig through the unchanged `runTypeCheck`. The report is one block per tool run (`universal-lint: <tool> found issues in <targets>:`), summary `universal-lint: N block(s) with findings.`; no edit-range gate, no `coalesceProjectCheck`. A multi-file chunk with a skip verdict reruns its files singly (at most 100 single spawns per chunk); a timed-out or killed chunk drops its findings for that run. Hook PostToolUse and FileChanged paths unchanged.

Measured on WSL2 ext4, node 24, `scratchpad/f16bench/` fixture, median of 5 driver runs (before = committed `plugin/` of 05996a1, 0.15.13):

| List    | Before   | After  | Target   |
| ------- | -------- | ------ | -------- |
| 10 .md  | 2,382 ms | 295 ms | ≤ 500 ms |
| 10 .mts | 1,794 ms | 195 ms | ≤ 500 ms |
| 10 .ts  | 1,851 ms | 195 ms | ≤ 400 ms |

Step 0 (pre-resolved `roots` in the driver) alone no longer pays on ext4 (0.4 ms per 10 files); it is kept only because the batch entry scopes all files itself.

## Problem

The driver calls `lintFileHandler` per file: one linter spawn (and one npx startup) per file, a whole-project tsc per .ts file, and, through the default `postToolScope`, `scopedTarget` without `roots`, so `realish(cwd)` runs per file. Every registered linter accepts multiple files, and the driver lints whole files (no gate) and aggregates one report anyway. In-process the probe caches do hit (2 probes per run).

## Evidence

- 10 .md (this repo): 13,981 ms vs one `npx --yes markdownlint-cli2 <10 files>` 1,139 ms, direct batched 381 ms. 6 .md: 7,945 vs 982 (npx) vs 279 ms (direct).
- 10 .mts: 11,494 ms (10 npx, 10 failed `rtk oxlint`) vs one batched direct oxlint 247 ms (single file 202 ms).
- 10 ts300 files: 12,666 ms = rtk lint 10× 10,029 ms + rtk tsc 10× 2,376 ms.
- `scopedTarget` per call: 73-96 ms on 9P at depth 9-10, about 0.1 ms on ext4 (stale: pre-F12 figure, not re-measured for F16; ext4 now 0.053 ms without roots / 0.010 ms with roots, so Step 0 is dropped as a separate change and only folded into the batch entry).

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

## Residuals

- Windows is out of scope: the hook runs via shebang without a `node` prefix, so the plugin does not run on Windows; `BATCH_MAX_FILES = 100` is sized for Linux/macOS ARG_MAX; no length-based chunking.
- Report granularity is per tool run, not per file: path-less row formats (eslint/stylelint stylish, yamllint standard) print their own file headers; the block header also names files the tool found clean.
- One timeout drops a whole chunk's findings for that run (no rerun: N files x 30 s); measured batch cost ~0.15 s per 10 files.
- No edit-range gate in the driver: every diagnostic a run prints is reported, including tsc diagnostics in unlisted project files (once per tsconfig instead of once per listed .ts file) and go/cargo package/crate-wide output.
