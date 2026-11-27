---
paths:
  - "*/tsdown.config.ts"
  - "*/hooks.template.json"
  - "*/mcp.template.json"
  - "*/assets/**"
  - "*/src/**"
  - "*/scripts/**"
  - "*/plugin/**"
  - "development/shared/src/**"
---

# Rule: the plugin build (published preset)

Every plugin is built by `tsdown` with the published preset `@kwitsch/tsdown-preset-claude-code` (exact `0.2.0`; universal-format exact `0.3.0`, dprint exact `0.4.1` for `hookTypes`, universal-lint exact `0.4.2`), beside `tsdown` exact `0.23.7`, both devDependencies of each plugin. Builds need Node 26 (preset `engines: >=26`, `target: node26`). Reasons, the minify matrix and what was rejected: [tsdown-plugin-build](../../development/wiki/decisions/tsdown-plugin-build.md).

- `tsdown.config.ts` is `export default await pluginConfig({ hooksTemplate, mcpTemplate, scripts, bundles, files, manifest: claudePlugin, overrides })`, with `claudePlugin` read from the plugin's own `package.json` (the preset ignores that key; forwarding it keeps `userConfig` and `dependencies`). `overrides.alias["@shared"]` only where `@shared` is imported. The `build` script is `tsdown` (dprint runs `claude-code-hook-types` before it).
- `hooks.template.json` (plugin root): `"mod": "./src/hooks/register.ts"` builds the mod to `plugin/hooks/register.js` (compressed, never mangled, no shebang) and renders `"modules": ["./register.js"]`. A `type: "command"` hook whose `command` is a relative `.ts` path builds to `plugin/hooks/<name>.mjs` and is rewritten to `"command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/hooks/<name>.mjs"]`; other keys (`timeout`, `async`, `asyncRewake`, `matcher`, `mcp_tool` hooks, a top-level `description`) pass through. Mods import no engine types (`claude-code`): type the used `$`/`on` members structurally.
- `mcp.template.json`: a server whose `command` is a relative `.ts` path builds to `plugin/mcp/<name>.mjs` and is rewritten the same way; `env` and other keys are kept. The key is the server name (`plugin:<plugin>:<key>`).
- Template commands are relative `.ts` paths with no arguments in the string.
- `scripts.skills: { "<skill>": ["src/skills/<skill>/<name>.ts"] }` builds to `plugin/skills/<skill>/<name>.mjs` (no subfolder; the skill name has no `/`), and `assets/skills/<skill>/SKILL.md` must name `<name>.mjs`. `scripts.bin` builds to `plugin/bin/<name>.mjs`. Scripts are fully minified, get a shebang and mode 0755; line 1 of the source is `#!/usr/bin/env node`.
- A command hook is `src/hooks/<hook-name>.ts`, named after the hook that calls it; one that several events call is one file named after what it does (`watch-paths`).
- `bundles: { "<outFolder>": "<source>.ts" }` builds a third-party bundle to `plugin/<outFolder>/index.mjs` plus chunks; a script that imports the bundle source keeps it as an external relative import. `files: { "<outPath>": "<source>" }` copies single files (0.3.0: fixed mode 0644). Own code never goes into a bundle.
- Hand-written shipped files (`README.md`, `skills/**`, `agents/*.md`) live in `<name>/assets/` at their `plugin/` path; the build removes `plugin/` first and copies `assets/`. Nothing under `plugin/` is hand-edited.
- Every output is one self-contained file: only `node:`-prefixed imports survive (write `node:fs`, never `fs`), plus a declared bundle; the build fails otherwise. No `plugin/hooks/lib.mjs`, no `plugin/shared/`.
- A module that another entry inlines must not start work at import (a top-level `main()`, a stdin loop, a server start): keep the entry a separate file that only calls it (universal-lint `watch-paths.ts`, `src/mcp/server.ts` and `lint-core.ts`).
- `@shared/<name>.js` (`development/shared/src/`) may be imported by any bundled file, the mod entry included; it is inlined. Code inlined into a mod loads in the engine, so [claude-code-hook-facts.md](claude-code-hook-facts.md) applies to it. Relative siblings are imported as `./name.js`.
- `scripts/*.ts` (a plugin's build steps and dev tools) run by Node's type stripping: erasable syntax only (no `enum`, `namespace`, parameter properties); they import their siblings with the real extension (`./x.ts`).
- The preset reports problems as `[claude-code] N problems` and fails the build (`strict`); with `claude` on PATH it also runs `claude plugin validate --strict` (`validate: "auto"`). `validate: false` only for a by-design warning, with a one-line comment.
- After a change of `src/`, `assets/`, a template, `package.json` or `tsdown.config.ts`: `pnpm lint && pnpm --filter <name> build && pnpm --filter <name> test`, then commit only the sources (`plugin/` is git-ignored). `pnpm lint` passes with 0 findings; no `oxlint-disable` without a stated reason.
- Unit tests import `src/`, process tests spawn built `plugin/**/*.mjs`, a mod's `claude-tests/` run on the built `plugin/`; no re-exports for tests: [hook-tests.md](hook-tests.md).
- Porting a shell script or CLI glue to Node, or reading Claude Code's own config files: read [porting-shell-to-node.md](../../development/wiki/pitfalls/porting-shell-to-node.md) first.
- A change of `development/shared/src/**` is a build-input change of each plugin aliasing `@shared`: CI demands each one's version bump (`changed-plugins.sh`). A preset or `tsdown` version change is a `package.json` build-input change and needs that plugin's bump.
