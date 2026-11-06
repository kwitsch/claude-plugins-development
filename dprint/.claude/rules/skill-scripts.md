---
paths:
  - "src/skills/dprint/**"
  - "plugin/skills/dprint/**"
  - "tests/{check-dprint,scan-plugins,run-dprint,skill}.test.mts"
  - "README.md"
---

# dprint skill scripts

Built to `plugin/skills/dprint/`, next to the hand-written `SKILL.md`, the `*.reference.md` contracts and
`dprint-plugins.json`:

- `check-dprint.mts`: dprint detection and minimum-version check (contract: `check-dprint.reference.md`).
- `scan-plugins.mts`: read-only scan of the project's file types against its dprint config, reads
  `dprint-plugins.json` (contract: `scan-plugins.reference.md`).
- `run-dprint.mts`: check/fmt dispatcher with the not-set-up gate (contract: `run-dprint.reference.md`).
- Shared modules (also imported by `src/mcp/`): `config-names.mts` (the six dprint config file names in
  `CONFIG_NAMES`), `find-config.mts`, `find-dprint.mts`.

## Resolution (single source; the MCP and notice rules refer here)

- `findDprint` (`find-dprint.mts`, async): `PATH`, then `~/.dprint/bin`, then `npx --yes dprint` (async probe, a
  failure re-probed after 30 s). `dprintArgv` builds the spawn arguments from the returned argv prefix.
- `findConfig` (`find-config.mts`): first of `CONFIG_NAMES` in a directory or its ancestors, never above the
  git/worktree root (nearest dir holding `.git`). Used by `run-dprint`, `scan-plugins` and `mcp/format`.

## Changing `MIN_VERSION`

Defined only in `check-dprint.mts`. Edit it there, update the "Minimum dprint version" line in `README.md`, rebuild,
and change the inlined copy in `src/hooks/notice.mts` too (`tests/notice.test.mts` fails while the two differ). Tests
read the value from the `.mts` source (the built script is minified).

## Refreshing `dprint-plugins.json`

Hand-written reference data, **not** build output: edit it in place.

1. Regenerate `plugins` from the `latest` array of `https://plugins.dprint.dev/info.json`, keeping registry order
   (it is the candidate preference order):
   - `id`: the URL path between `https://plugins.dprint.dev/` and `-<version>` (the name `dprint config add` accepts)
   - `npm`: the registry's `npm.name`; omit the key when there is none
   - `extensions`: the registry's `fileExtensions`, lower-cased, deduplicated, without a leading dot; drop dotted
     entries (for example `component.html`)
   - `fileNames`: the registry's `fileNames` verbatim; omit the key when there are none
   - skip entries with neither extensions nor file names (`exec`-only)
   - store no versions or URLs
2. Update `snapshot` to the refresh date (`YYYY-MM-DD`).
3. Run `pnpm --filter dprint test`.
