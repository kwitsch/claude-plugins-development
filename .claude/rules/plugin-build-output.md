---
paths:
  - "*/plugin/**"
  - "*/assets/**"
---

# Rule: plugin/ = shipped plugin only

Allowed in `plugin/`, nothing else:

- build output (never edit): `**/*.mjs` (minified, from `../src/**/*.ts`), `hooks/*.js` (the function-hooks module, `tsdown-build.md`), `.claude-plugin/plugin.json` (generated from `../package.json`), `hooks/hooks.json` and `.mcp.json` (generated from `../hooks.template.json` and `../mcp.template.json`)
- hand-written, copied from `../assets/` by the build (edit there): `README.md`, `skills/**/SKILL.md` + `*.reference.md` + data `*.json`, `agents/*.md`
- vendored third-party bundle (never edit; user decision 2026-11-17, universal-format's prettier): `**/vendor/*.mjs`, built by the preset's `bundles` option from exactly pinned devDependencies, plus the binary files that bundle loads at runtime, copied by the preset's `files` option and each listed by exact path under `pluginBuild.assets` in `../package.json`. Own code never goes there: it stays `src/**/*.ts`. Reasons: [vendored-bundles](../../development/wiki/decisions/repo-tooling.md#vendored-third-party-bundles-2026-11-17).

Everything else is forbidden (`*.ts`/`*.mts`, `tests/`, `*.test.*`, `CLAUDE.md`, engine output, …); the allowlist lives in `development/scripts/check-plugin-layout.ts`. Function-hooks modules too: source in `src/hooks/*.ts`, the generated `hooks.json` lists `./register.js`. Upstream code in another layout gets converted, never copied 1:1. Never edit this rule to fit a change — fix the change. CI runs the layout check on every fresh build (pr.yml, sync.yml) and fails on violations.

`.gitattributes` marks `pnpm-lock.yaml` `linguist-generated` and `*.wasm` `binary`.

- Build steps that clean or write under `plugin/` must not follow symlinks: a symlinked directory inside `plugin/` made the stale-output cleanup delete `.mjs` files outside the plugin, and a symlinked `plugin.json` was written through to a file outside. Use `lstat`, skip links, and make the layout check reject them.
