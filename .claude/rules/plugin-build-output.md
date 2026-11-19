---
paths:
  - "*/plugin/**"
---

# Rule: plugin/ = shipped plugin only

Allowed in `plugin/`, nothing else:

- build output (never edit): `**/*.mjs` (minified, from `../src/**/*.ts`), `.claude-plugin/plugin.json` (generated from `../package.json`)
- hand-written: `README.md`, `.mcp.json`, `hooks/hooks.json`, `skills/**/SKILL.md` + `*.reference.md` + data `*.json`, `agents/*.md`
- vendored third-party bundle (never edit; user decision 2026-11-17, universal-format's prettier): `**/vendor/*.mjs`, written by the plugin's own build step (`scripts/vendor.ts`, after `build-plugin.ts`) from exactly pinned devDependencies, plus the binary files that bundle loads at runtime, each listed by exact path under `pluginBuild.assets` in `../package.json`. Own code never goes there: it stays `src/**/*.ts`. Reasons: [vendored-bundles](../../development/wiki/decisions/repo-tooling.md#vendored-third-party-bundles-2026-11-17).

Everything else is forbidden (`*.ts`/`*.mts`, `tests/`, `*.test.*`, `CLAUDE.md`, engine output, …); the allowlist lives in `development/scripts/check-plugin-layout.ts`. Function-hooks modules too: source in `src/hooks/*.ts`, `hooks.json` lists `./<name>.mjs` (see dprint `notice`). Upstream code in another layout gets converted, never copied 1:1. Never edit this rule to fit a change — fix the change. CI fails on violations, and so does `pnpm build` (step 0, `development/scripts/build-plugin.ts`) of every plugin.

`.gitattributes` marks build output and the lockfile `linguist-generated` (collapsed in PRs); `*/plugin/**/*.mjs` is also `-diff -merge`: resolve conflicts there by rebuilding; `*.wasm` is `binary`.

- Build steps that clean or write under `plugin/` must not follow symlinks: a symlinked directory inside `plugin/` made the stale-output cleanup delete `.mjs` files outside the plugin, and a symlinked `plugin.json` was written through to a file outside. Use `lstat`, skip links, and make the layout check reject them.
