# dprint

Skill-only plugin: one model-invocable skill `init-dprint` (`plugin/skills/init-dprint/SKILL.md`) with two
zero-dep scripts and one data file, all in `plugin/skills/init-dprint/`:

- `check-dprint.mjs`: dprint detection and minimum-version check (contract: `check-dprint.reference.md`).
- `scan-plugins.mjs`: read-only scan of the project's file types against its dprint config (contract:
  `scan-plugins.reference.md`).
- `dprint-plugins.json`: hand-written plugin reference data read by `scan-plugins.mjs`. It is **not** build
  output; edit it in place.

`check-dprint.mjs`, `scan-plugins.mjs` and `plugin/.claude-plugin/plugin.json` are **build output** (`pnpm build`) of
`src/skills/init-dprint/check-dprint.mts`, `src/skills/init-dprint/scan-plugins.mts` and `plugin.json`. Do not edit
them here.

`MIN_VERSION` is defined only in the `.mts` source. Changing it: edit there, update the
"Minimum dprint version" line in `README.md`, rebuild. Tests read the value from the built script.

## Refreshing `dprint-plugins.json`

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
