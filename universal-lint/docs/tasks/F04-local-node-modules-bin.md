---
id: F04
title: Run project-local node_modules/.bin/<tool> directly instead of a doomed rtk attempt plus npx
status: open
priority: high
area: universal-lint/src/hooks/lint-file.mts (runLintTool npx-fallback branch, getRtkPrefix, tryRtk, runTypeCheck, walkUpToCwd), universal-lint/.claude/rules/languages.md, universal-lint/.claude/rules/hook-design.md
---

# F04 Run project-local node_modules/.bin/<tool> directly

## Status

Open. Merges bench-js-ts finding 4 (confirmed, high), real-sessions finding 3 (confirmed, high), static step 1 of the npx finding (adjusted, high), the static "failed rtk attempt repeats" finding (adjusted, medium) and the real-sessions missed item about sub-package configs. Needs a user decision: languages.md says tsc's `node_modules/.bin` special case "is deliberately not generalized to other tools" (written for the PHP vendor/bin gap; an accepted gap, not an explicit user decision).

## Problem

For an npm linter absent from PATH (oxlint in this repo, eslint/stylelint/markdownlint when installed as devDependencies), `runLintTool` first tries rtk's verb. `rtk oxlint` needs the binary on PATH and exits 127 with empty stdout every time; then `npx --yes oxlint` boots npm just to resolve the project's own `node_modules/.bin/oxlint`. Every .mts/.mjs/.ts edit and every FileChanged in this workspace pays both. `runTypeCheck` already prefers `<cwd>/node_modules/.bin/tsc`; chain tools do not. When the config and the binary live in a sub-package (dprint/eslint.config.mjs with eslint in dprint/node_modules), cwd-level resolution misses it entirely (F02's pnpm false findings).

## Evidence

- This repo, Write `universal-lint/src/hooks/lint-file.mts`: hook 890-1127 ms. Breakdown: onPath(oxlint) about 95 ms + rtk probe 18-32 + `rtk oxlint` exit 127 in 241-388 ms (59-72 ms with the Linux-only PATH) + `npx --yes oxlint` 450-722 ms. `node_modules/.bin/oxlint` direct: 199-390 ms (CPU 0.23 s vs npx 0.5 s real, 0.85 s user). Hook with `node_modules/.bin` prepended to PATH: 488-547 ms (rtk compacts).
- oxlint-ignored built file (`plugin/hooks/lint-file.mjs`): hook 693-824 ms, direct oxlint 53-61 ms.
- oxproj fixture: rtk oxlint 127 in 250-410 ms, then npx warm 661-728 ms, cold 6617 ms.
- Skill driver over 10 .mts: 11.5 s (10 failed rtk attempts + 10 npx) vs one batched direct oxlint 247 ms.
- Sessions: JS/TS family about 1564 of 3154 lintable edits; 258/300 TS-family edits in surviving project dirs have a local oxlint or eslint.
- In-session (live) FileChanged lint of lint-file.mts during a build: about 4.1 s.
- 0.15.2 (before F04), `node universal-lint/scripts/perf.mts 5`, `.mts Write (this repo)` medians: real PATH 578 ms, no /mnt 473 ms (npx route: `npx --yes oxlint` resolving the root `node_modules/.bin/oxlint`).

## Code locations

- `runLintTool` (`if (tool.npmSpec && !onPath(tool.name)) { getRtkPrefix … tryRtk(…RTK_NPX_ATTEMPT_TIMEOUT_MS) … spawnSync("npx", ["--yes", tool.npmSpec, …]) }`)
- `runTypeCheck` (the `localTsc` precedent), `walkUpToCwd`, `selectLintTool`, `getRtkPrefix`, `tryRtk`

## Approach

Before the npx branch, look for `node_modules/.bin/<tool.name>` from the file's directory up to cwd (`walkUpToCwd`; nearest wins, the same binary npx would pick). If found, either spawn rtk with that directory prepended to `PATH` in the spawn env (rtk then finds and compacts it; measured 488 ms) or spawn it directly (no compaction, about 250-390 ms). Run it with cwd = the directory holding that `node_modules` if the tool resolves configs relative to cwd (check eslint). Without a local bin keep rtk then npx, but skip the rtk attempt when the probed verb needs the literal binary (oxlint, markdownlint): a 127/empty-stdout result is certain. Document the rule in languages.md and hook-design.md (rtk compaction is lost when spawning directly).

## Verification

Tests: a stub at `<cwd>/node_modules/.bin/oxlint` (and one in a sub-package dir) is called; the npx and rtk-oxlint stubs record nothing. No local bin: behaviour unchanged. Bench: this repo's .mts Write from about 900-1100 ms to about 300-550 ms with no npx and no 127 in the trace; ignored built .mjs about 100 ms.

## Constraints

User decision needed (languages.md "not generalized"). Zero-dependency runtime. Never execute anything outside the cwd tree. Fail open if the local bin fails to spawn (fall back to today's path). Version bump.

## Related

F02 (sub-package false findings), F09 (npx-cache-only tools), F11 (savings not additive: rtk/npx scan PATH themselves), F16, F19, F27.
