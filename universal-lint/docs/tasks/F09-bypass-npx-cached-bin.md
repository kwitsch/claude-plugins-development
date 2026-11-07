---
id: F09
title: Spawn the cached npx bin directly instead of npx --yes
status: open
priority: high
area: universal-lint/src/hooks/lint-file.mts (runLintTool npx-fallback branch, REGISTRY npmSpec entries, NPX_SPAWN_TIMEOUT_MS)
---

# F09 Spawn the cached npx bin directly instead of npx --yes

## Status

Open. Merges bench-other-langs finding (confirmed, high), the real-sessions missed item (npx overhead for tools not installed locally, high) and step 2 of the static npx finding. Largest per-edit waste on the most edited file type (.md).

## Problem

Tools that are neither on PATH nor in `node_modules/.bin` (typical for markdownlint-cli2, stylelint) run as `npx --yes <pkg>` on every lint. npm's own startup and tree resolution adds about 0.5-0.8 s per call even with a warm cache and `--offline`; occasional registry revalidation pushes single calls to 2.9-3.8 s. F04 does not help here: 0/294 .md edits in surviving project dirs had a local markdownlint(-cli2).

## Evidence

- markdownlint-cli2: direct `~/.npm/_npx/3c2a9ea6c4b6e0a2/node_modules/.bin/markdownlint-cli2` 218-345 ms vs `npx --yes` 807-1136 ms; `npm_config_offline=true` 764 vs 854 ms, `--offline` with a pinned version about 115 ms faster, still about 500 ms above direct. stylelint: direct 224-309 vs npx 853-885 ms.
- .md hook: 1113-1137 ms median, npx 855-1018 ms of it. CLAUDE.md in this repo 1254-1644 ms.
- Variant maxima 2952-3833 ms (registry revalidation).
- npx cache dir = `~/.npm/_npx/<sha512(spec) hex[0:16]>`, verified independently: markdownlint-cli2 3c2a9ea6c4b6e0a2, stylelint 69cd2ba96dd4b8d2, markdownlint-cli 10f54a790ecaa614, eslint 515228b7c8d004a2 (npm 11.19.1). The cache's package.json pins `^0.24.0`.
- Sessions: .md is 1338-1906 edits (about 38-42% of lintable edits); markdownlint-cli2 produced 222-224 of the real findings.
- Skill driver, 10 .md: 13,981 ms vs one batched direct call 381 ms.

## Code locations

`runLintTool` (`spawnSync("npx", ["--yes", tool.npmSpec, ...argv], { timeout: NPX_SPAWN_TIMEOUT_MS })`); `REGISTRY` entries with `npmSpec` (markdownlint-cli2, markdownlint, stylelint, eslint, oxlint).

## Approach

Two options, pick one (both keep npx as the cold-install route and fallback):

1. Compute `${npm_config_cache || ~/.npm}/_npx/<sha512(npmSpec).hex.slice(0,16)>/node_modules/.bin/<tool.name>`; if it exists, spawn it directly under `SPAWN_TIMEOUT_MS`. Depends on npm's `_npx` layout (npm 7+); a cache dir set only in `.npmrc` is just a miss.
2. More robust: after the first successful npx run, resolve the bin path once (`npx --yes -p <pkg> -c 'command -v <bin>'`), persist it in the F11 cache file under `CLAUDE_PLUGIN_DATA`, re-validate with one `accessSync`, and fall back to npx when it is gone.

Accepted cost: the npx package is not refreshed until npx runs again (npx's own reuse of an existing cache dir behaves much the same). Decide how this interacts with the rtk attempt in the npx branch (markdownlint-cli2 has no rtk verb; for eslint see F02).

## Verification

Bench: .md hook from about 1.1 s to about 300-350 ms; stylelint-config .css about 350 ms. Test: with a fake cached bin present the npx stub records nothing; after removing it the npx fallback runs. Cold cache (fresh `npm_config_cache`): first run via npx, second run direct.

## Constraints

Keep the npx fallback for every failure; fail open. Zero-dependency (sha512 via `node:crypto`). Version bump. Document in hook-design.md "npx fallback".

## Related

F04 (local bins first), F11 (shared cache file for option 2), F16 (skill driver), F24 (npm notices disappear on the direct path), F06/F07.
