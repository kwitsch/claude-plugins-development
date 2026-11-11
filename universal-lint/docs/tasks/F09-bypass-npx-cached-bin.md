---
id: F09
title: Spawn the cached npx bin directly instead of npx --yes
status: done
priority: high
area: universal-lint/src/hooks/lint-file.mts (runLintTool npx-fallback branch, runNpx, spawnBin, NPX_REFRESH_MS, REGISTRY npmSpec entries, NPX_SPAWN_TIMEOUT_MS)
---

# F09 Spawn the cached npx bin directly instead of npx --yes

## Status

Done in 0.15.8. Shipped: option 1 (computed `_npx` path) plus two "would npx run this?" guards and a 24 h refresh stamp. `runLintTool`'s npx branch delegates to `runNpx`, which spawns `${npm_config_cache || NPM_CONFIG_CACHE || ~/.npm}/_npx/<sha512(npmSpec) hex[0:16]>/node_modules/.bin/<name>` directly through `spawnBin` (F04's local-bin spawn moved into a helper: bin dir first on PATH, npx's cwd, `NPX_SPAWN_TIMEOUT_MS`), so local bin -> npx-cache bin -> npx is one fall-through chain ending in the single npx spawn; only ENOENT/EACCES falls through, a timeout is returned as is. Plain `npx --yes`, exactly as in 0.15.7, runs instead when a `node_modules/.bin/<name>` exists from the spawn cwd up to `/` (npx's own lookup runs that one before its cache; F04 user decision), when npx holds the cache dir's `concurrency.lock` (install in progress), or when the refresh stamp `${CLAUDE_PLUGIN_DATA || os.tmpdir()}/npx-refreshed-<key>` is missing or older than `NPX_REFRESH_MS` (24 h); every npx run that spawned renews the stamp (errors swallowed), except the above-cwd one, which never touches the cache. The hook only reads the npm cache, never writes it. Measured (same machine and session, label in hook-design.md "Measured cost"), 0.15.7 -> 0.15.8: `.md Write` (`perf.mts 5`) real PATH 1066 -> 476 ms, no /mnt 874 -> 287 ms; `.css` Write with a stylelint config (manual, 1 warm-up + 5 runs) 951 -> 359 ms. The skill driver takes the same route through `lintFileHandler`.

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

`runLintTool` (local bin through `spawnBin`, then `runNpx` for an npm chain tool absent from PATH, else a direct spawn); `runNpx` (above-cwd walk via `walkToRoot`, cache key and dir, refresh stamp, `concurrency.lock` check, the `spawnSync("npx", ["--yes", npmSpec, ...argv], { timeout: NPX_SPAWN_TIMEOUT_MS })` fallback and the stamp renewal); `spawnBin`; `NPX_REFRESH_MS`; `REGISTRY` entries with `npmSpec` (markdownlint-cli2, markdownlint, stylelint, eslint, oxlint).

## Approach

Shipped option 1: compute `${npm_config_cache || NPM_CONFIG_CACHE || ~/.npm}/_npx/<sha512(npmSpec).hex.slice(0,16)>/node_modules/.bin/<tool.name>` and spawn it directly under `NPX_SPAWN_TIMEOUT_MS`, without an existence pre-check (a missing, dangling or non-executable bin gives ENOENT/EACCES, which falls through to npx). Depends on npm's `_npx` layout (npm 7+); a cache dir set only in `.npmrc` is just a miss. Added on top: the above-cwd `node_modules/.bin/<name>` walk (npx would run that bin first; F04 user decision), the `concurrency.lock` check (a half-replaced tree could crash with exit 1, a false finding; a no-op on npm 10.x and older, which have no lock) and the 24 h refresh stamp in plugin data (not the `_npx/<key>` dir mtime: `libnpmexec` ships `with-lock.js` only from 10.2.0 (npm 11.x), so on Node 22 LTS's npm 10.9 the dir mtime moves only on installs).

Not taken: option 2 (after the first npx run, resolve the bin path with `npx --yes -p <pkg> -c 'command -v <bin>'`, persist it in the F11 cache file under `CLAUDE_PLUGIN_DATA`, re-validate with one `accessSync`): it needs F11's cache file, which does not exist yet, costs a second npm boot per cold or refreshed spec, and still needs a staleness rule.

Accepted cost: npx checks a name-only spec against the registry's `latest` on every call (npm 11.19.1 `libnpmexec` `getManifest` with `preferOnline: true`), so npx's own reuse of a cache dir does not behave like a direct bin, and without a refresh rule the direct route would lag new releases without bound. The shipped 24 h stamp bounds the lag to one day, at the cost of one npx run per package per day. The original question of how this interacts with the rtk attempt in the npx branch (markdownlint-cli2 has no rtk verb; for eslint see F02) is obsolete: rtk support was removed in 0.15.0.

## Verification

Tests (`tests/npx-fallback.test.mts`, markdownlint-cli2 as the representative tool, cache key `3c2a9ea6c4b6e0a2` hard-coded): with a fake cached bin and a fresh stamp the bin runs directly (bin dir first on PATH, npx's cwd) and the npx stub records nothing, after removing it the npx fallback runs; a cold `npm_config_cache` runs npx first (stamp written, the hook creates no cache root) and the cached bin the second time; a stamp older than 24 h sends one run through npx and the renewed stamp makes the next run direct; a cached bin without the exec bit, an npx `concurrency.lock` and a `node_modules/.bin/markdownlint-cli2` above cwd each send the lint through npx. Bench (0.15.7 vs 0.15.8, same session): `.md Write` real PATH 1066 -> 476 ms (`perf.mts 5`; target was about 300-350 ms); stylelint-config `.css` Write 951 -> 359 ms (manual; target about 350 ms).

## Constraints

Keep the npx fallback for every failure; fail open. Zero-dependency (sha512 via `node:crypto`). Version bump. Document in hook-design.md "npx fallback".

## Related

F04 (local bins first), F11 (shared cache file for option 2), F16 (skill driver), F24 (npm notices disappear on the direct path), F06/F07.
