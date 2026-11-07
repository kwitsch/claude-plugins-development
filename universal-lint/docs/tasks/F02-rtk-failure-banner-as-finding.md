---
id: F02
title: rtk failure banners are reported as eslint findings (false rewake, pnpm install in the repo)
status: open
priority: high
area: universal-lint/src/hooks/lint-file.mts (tryRtk, runLintTool npx-fallback branch, getRtkPrefix, classifyExit 'eslint', gateFinding)
---

# F02 rtk failure banners are reported as eslint findings

## Status

Open. Merges bench-js-ts finding 1 (adjusted, high), the real-sessions eslint finding (adjusted, high: the safety-net part) and two verifier missed items (no-config scope, timeout-dependent self-healing). Top item of the analysis.

## Problem

In the npx-fallback branch `runLintTool` runs `rtk lint <file>` for eslint. rtk runs `npx --no-install -- eslint -f json` (or `pnpm exec eslint` in a pnpm repo). When eslint is not reachable that fails, but rtk prints a non-empty banner and exits 1: `ESLint output (JSON parse failed: EOF while parsing a value at line 1 column 0)`, or pnpm's `[ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL] Command "eslint" not found`. `tryRtk` treats a non-zero exit as rtk-internal only when stdout is empty, so it accepts the banner; `classifyExit('eslint', 1)` says issues; the banner has no line location, so `gateFinding` passes it through even after an Edit. The hook exits 2 and wakes Claude with garbage on every JS/TS edit. Bare `npx --yes eslint` never runs, so the npx cache never warms. In a pnpm repo `pnpm exec` first runs an install, creating `node_modules/` in the user's repo: the read-only hook mutates the project.

## Evidence

- Fresh `npm_config_cache`, flat-config project (a.js): 5/5 runs exit 2 with `eslint found issues in a.js: ESLint output (JSON parse failed: EOF ...)` in 1009-1434 ms. rtk tee log: `npx canceled due to missing packages and no YES option: ["eslint@10.14.0"]`. `rtk lint a.js` alone: exit 1 after 1393 ms with the banner on stdout.
- No lint config at all: noconf/a.js 3/3 exit 2; ts300 `src/m150.ts` Edit 1/1 exit 2 (1245-1711 ms). With a warm cache the no-config file exits 0.
- Self-healing only when slow: in one 85 s cold run the rtk attempt overran `RTK_NPX_ATTEMPT_TIMEOUT_MS` (5 s), was killed, and bare `npx --yes eslint` installed eslint. A fast "npx canceled" answer (about 1.4 s) never falls through.
- pnpm fixture, no eslint config: 618 ms median, exit 2 with the pnpm "not found" text; fresh fixture without node_modules: 1090 ms, stderr carries the pnpm install log, `node_modules/` created (pnpm-lock.yaml stayed byte-identical in the verifier's fixture).
- History (0.10.x transcripts): 174 of 206 eslint findings (84%) were false: 128 pnpm "not found" (14 with a full install log), 46 "JSON parse failed". 91 of the 128 are dprint/ files with `dprint/eslint.config.mjs` and eslint in `dprint/node_modules` while the hook ran from the repo root. Re-gated with 0.14.0: 204/205 eslint findings would still wake Claude.

## Code locations

- `tryRtk` (acceptance rule: non-zero exit + non-empty stdout = real result)
- `runLintTool` (branch `tool.npmSpec && !onPath(tool.name)`: rtk attempt, then `npx --yes`)
- `getRtkPrefix` / `parseRtkPrefix` (eslint maps to `rtk lint`)
- `classifyExit` case `eslint`; `gateFinding` (unlocated text = fail open = report)

## Approach

Safety net in `tryRtk` (or the npx branch only): treat an rtk result whose output matches rtk/pnpm failure banners (`/JSON parse failed|ERR_PNPM_|Command "[^"]+" not found|command not found|npx canceled/`) as an rtk failure and fall through to `npx --yes`. Simpler alternative: in the npx branch skip rtk for eslint entirely when eslint is not on PATH (rtk's verbs need the binary or an already-cached package); that also removes the rtk-127 case in F04. Keep the `RTK_NPX_ATTEMPT_TIMEOUT_MS` bound. The pnpm install side effect disappears only when rtk is not run in that case (or once F03 skips the no-config case and F04 finds the sub-package's local eslint). The banner safety net alone does NOT stop it: `rtk lint` has already run `pnpm exec`, and with it the install, by the time the banner is rejected. Because the hook must stay read-only, prefer the skip-rtk alternative, or ship it together with the safety net.

## Verification

Test (rtk.test.mts or npx-fallback.test.mts): an rtk stub whose `lint` verb prints `ESLint output (JSON parse failed: ...)` and exits 1 FAST, plus an npx stub that records its call: expect `npx --yes` to run and no banner in the finding. Same with a pnpm-style "Command \"eslint\" not found" banner. Bench: flat-config project with a fresh cache shows the real `no-unused-vars` finding (first run about 7.5 s cold, then about 1.9 s). In a pnpm fixture without node_modules, no `node_modules/` appears after the hook. This check passes only with the skip-rtk variant (or with F03 or F04), not with the banner filter alone.

## Constraints

Never reintroduce `rtk npx --yes` (documented as uncompacted, hook-design.md "rtk compaction"). The skip-rtk variant reverses the documented "npx-fallback branch: try `rtk`'s own verb first (`rtk lint`)" rule. That is an explicit trade-off: the npx-run eslint output is no longer compacted (more tokens per finding). Confirm it with the user and update hook-design.md. Fail-open contract unchanged; the hook must stay read-only. Version bump.

## Related

F03 (no-config half), F04 (local bin walk from the file's directory fixes the sub-package case), F14 (rtk lint output defeats the edit gate), F27 (tests).
