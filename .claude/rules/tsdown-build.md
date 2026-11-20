---
paths:
  - "*/tsdown.config.ts"
  - "development/tsdown/**"
  - "*/src/**"
  - "*/plugin/**"
---

# Rule: the tsdown plugin build (the standard)

A plugin with a `tsdown.config.ts` is built by `tsdown` through `pluginConfig` (`development/tsdown/index.ts`); Every plugin is built by `tsdown` through `pluginConfig` (`development/tsdown/index.ts`). Reasons, the minify matrix and what was rejected: [tsdown-plugin-build](../../development/wiki/decisions/tsdown-plugin-build.md).

- `tsdown.config.ts` is `export default pluginConfig({ mods: [...], scripts: [...] })`; an entry is a path below `src/` without extension (`"hooks/register"`, `"bin/mcp"`). Only a listed entry produces a file; every other `src/` module is inlined into the entries that import it. The `build` script is `tsdown`.
- `mods` (function-hooks modules): `src/hooks/register.ts` builds to `plugin/hooks/register.js`, compressed but never mangled (`minify: { mangle: false, compress: true }`), no shebang; `hooks.json` lists `./register.js`.
- `scripts` (MCP servers, command hooks, bin scripts): `src/<entry>.ts` builds to `plugin/<entry>.mjs`, fully minified, mode 0755; line 1 of the source is `#!/usr/bin/env node`. A command hook is `src/hooks/<hook-name>.ts`, named after the hook that calls it.
- Every output is one self-contained file: only `node:`-prefixed imports survive (write `node:fs`, never `fs`) and there is no dynamic `import()`; the build fails otherwise. No `plugin/hooks/lib.mjs`, no `plugin/shared/`.
- `@shared/<name>.js` (`development/shared/src/`) may be imported by any bundled file, the mod entry included; it is inlined. Code inlined into a mod loads in the engine, so [claude-code-hook-facts.md](claude-code-hook-facts.md) applies to it.
- Build output in `plugin/` is `**/*.mjs`, `hooks/*.js` and `.claude-plugin/plugin.json`: never edit it. The build deletes every other `.mjs`/`.js` there except `pluginBuild.assets`.
- After a change of `src/`, `package.json` or `tsdown.config.ts`: `pnpm lint && pnpm --filter <name> build && pnpm --filter <name> test`, then commit the regenerated `plugin/` with the source.
- Unit tests import `src/`, process tests spawn built `plugin/**/*.mjs`, a mod's `claude-tests/` run on the built `plugin/`; no re-exports for tests: [hook-tests.md](hook-tests.md).
- A change of `development/tsdown/**` or `development/shared/src/**` rebuilds every tsdown-built plugin; each one whose `plugin/` changes needs a version bump.
