---
paths:
  - "*/tsdown.config.ts"
  - "*/src/**"
  - "*/scripts/**"
  - "*/plugin/**"
  - "development/tsdown/**"
  - "development/shared/src/**"
---

# Rule: the tsdown plugin build (the standard)

Every plugin is built by `tsdown` through `pluginConfig` (`development/tsdown/index.ts`); `graphmind-helper` alone uses the published preset `@kwitsch/tsdown-preset-claude-code` (templates, `assets/`, `mcp/<name>.mjs`; [preset-migration](../../development/wiki/plugins/graphmind-helper/design/preset-migration.md)) until the other plugins follow, and `development/tsdown` goes only when all eight have moved. Reasons, the minify matrix and what was rejected: [tsdown-plugin-build](../../development/wiki/decisions/tsdown-plugin-build.md).

- `tsdown.config.ts` is `export default pluginConfig({ mods: [...], scripts: [...], vendor: [...] })`; an entry is a path below `src/` without extension (`"hooks/register"`, `"bin/mcp"`). Only a listed entry produces a file; every other `src/` module is inlined into the entries that import it. The `build` script is `tsdown` (a plugin's own steps may run before or after it: dprint `scripts/hooks.ts`, universal-format `scripts/vendor.ts`).
- `mods` (function-hooks modules): `src/hooks/register.ts` builds to `plugin/hooks/register.js`, compressed but never mangled (`minify: { mangle: false, compress: true }`), no shebang; `hooks.json` lists `./register.js`. Mods import no engine types (`claude-code`): type the used `$`/`on` members structurally.
- `scripts` (MCP servers, command hooks, skill and bin scripts): `src/<entry>.ts` builds to `plugin/<entry>.mjs`, fully minified, mode 0755; line 1 of the source is `#!/usr/bin/env node`. A command hook is `src/hooks/<hook-name>.ts`, named after the hook that calls it; one that several events call is one file named after what it does (`watch-paths`, `lint-file`). Callers reference a bin script as `${CLAUDE_PLUGIN_ROOT}/bin/<name>.mjs`.
- Every output is one self-contained file: only `node:`-prefixed imports survive (write `node:fs`, never `fs`) and there is no dynamic `import()`; the build fails otherwise. No `plugin/hooks/lib.mjs`, no `plugin/shared/`.
- A module that another entry inlines must not start work at import (a top-level `main()`, a stdin loop, a server start): keep the entry a separate file that only calls it (universal-lint `lint-file.ts` and `lint-core.ts`).
- `vendor` lists directories of a vendored third-party bundle (`"mcp/vendor"`): `src/<dir>/index.d.ts` holds the types, the plugin's own build step writes `plugin/<dir>/index.mjs` after tsdown, an import of `./vendor/index.js` stays external and the stale-output removal skips the directory. Own code never goes there.
- `@shared/<name>.js` (`development/shared/src/`) may be imported by any bundled file, the mod entry included; it is inlined. Code inlined into a mod loads in the engine, so [claude-code-hook-facts.md](claude-code-hook-facts.md) applies to it. Relative siblings are imported as `./name.js`.
- `scripts/*.ts` (a plugin's build steps and dev tools) run by Node's type stripping: erasable syntax only (no `enum`, `namespace`, parameter properties); they import their siblings with the real extension (`./x.ts`).
- Build output in `plugin/` is `**/*.mjs`, `hooks/*.js` and `.claude-plugin/plugin.json`: never edit it. The build deletes every other `.mjs`/`.js` there except `pluginBuild.assets` and vendor directories.
- After a change of `src/`, `package.json` or `tsdown.config.ts`: `pnpm lint && pnpm --filter <name> build && pnpm --filter <name> test`, then commit the regenerated `plugin/` with the source. `pnpm lint` passes with 0 findings; no `oxlint-disable` without a stated reason.
- Unit tests import `src/`, process tests spawn built `plugin/**/*.mjs`, a mod's `claude-tests/` run on the built `plugin/`; no re-exports for tests: [hook-tests.md](hook-tests.md).
- Porting a shell script or CLI glue to Node, or reading Claude Code's own config files: read [porting-shell-to-node.md](../../development/wiki/pitfalls/porting-shell-to-node.md) first.
- A change of `development/tsdown/**` or `development/shared/src/**` rebuilds every plugin; each one whose `plugin/` changes needs a version bump.
