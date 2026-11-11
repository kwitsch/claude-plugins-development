---
id: F04
title: Run project-local node_modules/.bin/<tool> directly instead of npx
status: done
priority: high
area: universal-lint/src/hooks/lint-file.mts (selectLintTool, localBin, runLintTool, runChainLint, walkUpToCwd, scopedTarget/outside), universal-lint/scripts/perf.mts, universal-lint/.claude/rules/hook-design.md, universal-lint/.claude/rules/languages.md, universal-lint/plugin/README.md
---

## Status

Done in 0.15.3. User decision (q1): "all five npm chain tools; tsc keeps its cwd-only lookup": `oxlint`, `eslint`, `stylelint`, `markdownlint-cli2` and `markdownlint` (the chain entries with `npmSpec`), when absent from `PATH`, run the nearest `node_modules/.bin/<name>` from the file's directory up to cwd before falling back to `npx --yes`; `tsc` keeps `PATH`, then `<cwd>/node_modules/.bin/tsc` (no walk). User decision (q2): the npx fallback stays as in 0.15.2. Tests (`tests/npx-fallback.test.mts`, six): a local oxlint at cwd runs with its directory first on the child's `PATH` and no npx; the nearest `node_modules/.bin` wins; lookup by bin name (a local `markdownlint` beats npx `markdownlint-cli2`); a local bin that cannot spawn falls back to npx; a file reached through a symlinked directory outside cwd never runs an above-cwd bin; a chain tool on `PATH` still wins. Measured with `node universal-lint/scripts/perf.mts 5`, `.mts Write (this repo)` medians in ms, before (0.15.2) -> after (0.15.3): real PATH 578 -> 338, no /mnt 473 -> 244. The rtk parts of the original task (the rtk-prepend variant, skipping the doomed rtk attempt) are obsolete: rtk support was removed in 0.15.0.

## Problem

History (0.14.x, rtk era): for an npm linter absent from PATH (oxlint in this repo, eslint/stylelint/markdownlint when installed as devDependencies), `runLintTool` first tried rtk's verb. `rtk oxlint` needs the binary on PATH and exits 127 with empty stdout every time; then `npx --yes oxlint` boots npm just to resolve the project's own `node_modules/.bin/oxlint`. Every .mts/.mjs/.ts edit and every FileChanged in this workspace paid both; from 0.15.0 to 0.15.2 (no rtk) the npx boot remained. `runTypeCheck` already preferred `<cwd>/node_modules/.bin/tsc`; chain tools did not. When the config and the binary live in a sub-package (dprint/eslint.config.mjs with eslint in dprint/node_modules), cwd-level resolution misses it entirely (F02's pnpm false findings).

## Evidence

- 0.14.x history (rtk era, as are the next five bullets): this repo, Write `universal-lint/src/hooks/lint-file.mts`: hook 890-1127 ms. Breakdown: onPath(oxlint) about 95 ms + rtk probe 18-32 + `rtk oxlint` exit 127 in 241-388 ms (59-72 ms with the Linux-only PATH) + `npx --yes oxlint` 450-722 ms. `node_modules/.bin/oxlint` direct: 199-390 ms (CPU 0.23 s vs npx 0.5 s real, 0.85 s user). Hook with `node_modules/.bin` prepended to PATH: 488-547 ms (rtk compacts).
- oxlint-ignored built file (`plugin/hooks/lint-file.mjs`): hook 693-824 ms, direct oxlint 53-61 ms.
- oxproj fixture: rtk oxlint 127 in 250-410 ms, then npx warm 661-728 ms, cold 6617 ms.
- Skill driver over 10 .mts: 11.5 s (10 failed rtk attempts + 10 npx) vs one batched direct oxlint 247 ms.
- Sessions: JS/TS family about 1564 of 3154 lintable edits; 258/300 TS-family edits in surviving project dirs have a local oxlint or eslint.
- In-session (live) FileChanged lint of lint-file.mts during a build: about 4.1 s.
- 0.15.2 (before F04), `node universal-lint/scripts/perf.mts 5`, `.mts Write (this repo)` medians: real PATH 578 ms, no /mnt 473 ms (npx route: `npx --yes oxlint` resolving the root `node_modules/.bin/oxlint`).
- 0.15.3 (after F04), same harness, machine and day, `.mts Write (this repo)` medians: real PATH 338 ms, no /mnt 244 ms (local route: the root `node_modules/.bin/oxlint` spawned directly; full run in `.claude/rules/hook-design.md` "Measured cost").

## Code locations

- `selectLintTool` (three passes: PATH, then `localBin`, then npx; returns `{ tool, local }`)
- `localBin` (nearest `node_modules/.bin/<name>` over `walkUpToCwd`, per-directory `outside` guard), `outside` (lifted from `scopedTarget`)
- `runLintTool` (local spawn before the npx branch; fall-through on a spawn error), `runChainLint` (threads `path.dirname(resolved)` in and `sel.local` through)
- `scripts/perf.mts` (case `.mts Write (this repo)`), `plugin/README.md` (user-facing wording)

## Approach

Shipped: `selectLintTool(chain, fileDir, cwd)` runs three passes over the chain: the first tool on `PATH`; else the first `npmSpec` tool whose `localBin(tool.name, fileDir, cwd)` finds a bin (the nearest `node_modules/.bin` from the file's directory up to cwd inclusive; a directory outside cwd never counts); else, when `npx` is on `PATH`, the first `npmSpec` tool through npx. PATH first matches the `tsc` precedent and changes only runs that used npx; a separate local pass means an installed chain tool beats an npx-only one regardless of chain order. `runLintTool` spawns the local bin directly from its package root (the directory holding the selected `node_modules`; `Finding.base` follows it, the target and the edit-range gate stay cwd-relative) and the bin's directory first on the child's `PATH`, as npx does (oxlint 1.91 finds `tsgolint` only there or in the spawn cwd's `node_modules/.bin`), under `SPAWN_TIMEOUT_MS`. Fail open on a spawn error only: an error without a signal (ENOENT/EACCES) falls through to the unchanged npx branch, a timeout returns as is. The package-root spawn cwd (the alternative first rejected) is applied after review: eslint <= 9 resolves its flat config from the spawn cwd. Residual (same as 0.15.2): an eslint <= 9 bin at the cwd level with a config only in a sub-directory still resolves from cwd.

Trust: (1) a bin in `<cwd>/node_modules/.bin` is the one `npx` runs today (npm's own lookup starts at cwd); (2) a sub-package bin between the file and cwd is a new execution surface of the same trust class (the project tree the user asked to lint), never above cwd; (3) the local route never runs a bin above cwd, so where an in-tree bin exists, an above-cwd bin that npx's own walk would have reached instead is no longer run. Without an in-tree bin, the npx fallback is unchanged from 0.15.2 and resolves `<name>` as npm does (npm 11.19.1 walks from cwd up to `/`, probed), with the same trust as any `npx` the user runs; it is deliberately not blocked, since that would drop lint for a monorepo sub-package session whose linters sit at the monorepo root (user decision, F04, 0.15.3).

## Verification

Run: `pnpm --filter universal-lint build && pnpm --filter universal-lint test && pnpm lint`: the six tests in `tests/npx-fallback.test.mts` (see Status; the symlink test fails without the `outside` guard in `localBin`) plus the unchanged npx-fallback, oxlint, markdown, stylelint, tsc, registry and manifest tests. Bench: `node universal-lint/scripts/perf.mts 5` once on the 0.15.2 build (with the new case committed first) and once on the 0.15.3 build; `.mts Write (this repo)` real PATH 578 -> 338 ms, no /mnt 473 -> 244 ms; the after run is the "Measured cost" table in `.claude/rules/hook-design.md`. The original target "about 900-1100 ms to about 300-550 ms" came from the 0.14.x rtk-era trace; the comparison of record is the harness before/after.

## Constraints

Recorded user decisions (F04, 0.15.3): q1, the `node_modules/.bin` lookup covers the five npm chain tools and `tsc` keeps its cwd-only lookup (this replaced languages.md's "not generalized" sentence); q2, the npx fallback stays unchanged and is not blocked from resolving an above-cwd bin. Zero-dependency runtime. The local route never executes a bin outside the cwd tree. Fail open if the local bin fails to spawn (fall back to npx). Version bump (0.15.3).

## Related

F02 (sub-package false findings), F09 (npx-cache-only tools; its cached-bin route goes inside `runLintTool`'s npx fall-through branch, after the local-bin attempt), F11 (0.14.x wording: "savings not additive: rtk/npx scan PATH themselves"; rtk is gone since 0.15.0), F16, F19, F27.
