---
name: split-hooks-lib
description: Split the hooks module of a function-hooks plugin of this repository into a readable entry register.mts plus helper modules that the build bundles into one compressed plugin/hooks/lib.mjs, to keep the shipped size small. Use when the user asks to split a plugin's register.mts, to make a plugin smaller, to move a plugin to register.mjs plus lib.mjs, or when a hooks module has grown too large for one file.
argument-hint: "<plugin-name>"
---

# split-hooks-lib

The repository prefers this layout for every function-hooks plugin (decided with jev-api 0.4.0, PR #99): `plugin/hooks/register.mjs` stays readable (Claude Code's static check reads it), everything else ships as one compressed `plugin/hooks/lib.mjs`. Do not apply it to plugins without a function-hooks module (command hooks, MCP servers only).

The argument is the plugin directory name. Stop with one line if `<plugin>/src/hooks/register.mts` or `<plugin>/plugin/hooks/hooks.json` does not exist. Work in a worktree on a `feat/` branch (never nest, `EnterWorktree` when the session is not in one).

## 1. Check the plugin

- `plugin/hooks/hooks.json` lists the entry modules (`{ "modules": ["./register.mjs"] }`). Every other `src/hooks/*.mts` becomes a helper and ends up in `lib.mjs`; the listed ones stay separate and unminified. A plugin that lists several entry modules is fine, each keeps its file.
- Helpers must obey (the build checks the first three and fails with a message): import siblings only as named imports from `./name.mjs` (no default, no namespace import, no `import()`), no import cycles, unique top-level names across all helpers, and no state at module level (the test kit reloads only the entry per test, so module state would leak between tests; keep it inside `register()`).
- Everything the engine's static check reads stays in the entry: `$.env.get("NAME")` with a literal name, `on(...)` calls with named function literals, `$.command.register({ name })` literals. Helpers receive `$` as a parameter and may call any engine member whose argument is not statically checked; if unsure, keep the call in the entry.
- Record the shipped size first: `wc -c <plugin>/plugin/hooks/*.mjs`.

## 2. Split the source by symbol

Split along real boundaries, not by line count. Proven layout (jev-api): `types.mts` (engine, hook and domain types plus name lists), `util.mts` (guards, `json`, error builders, redaction), `tools.mts`/schemas, `input.mts` (validation), domain modules (one per concern), `registry.mts`, and `register.mts` with only `register(on, options)`. Constants go with the module that owns the rule, not with the first user.

Use the script in [split.reference.md](split.reference.md): list every top-level symbol per target file in its `MAP`, it cuts the TSDoc plus declaration chunks, adds `export` to moved declarations, generates the imports (types as `import type`), and fails on an unassigned or unknown symbol. Then:

1. `pnpm lint` (the root one): remove imports it flags as unused (the script matches names in code, a name inside a string literal can slip in), fix the register file header comment (it must no longer claim "no imports").
2. Replace redundant helpers the split made visible, but make no behaviour change in this step.

## 3. Turn the bundling on

In `<plugin>/package.json` add `"pluginBuild": { "bundleHooksLib": true }` (top level, not inside `claudePlugin`). Then `pnpm --filter <plugin> build`: `plugin/hooks/` holds `register.mjs` (imports one `./lib.mjs`), `lib.mjs` (compressed, whitespace removed, deliberately not mangled so `$` and the engine calls stay spelled as in the sources) and `hooks.json`. The tests need no change when they import only `plugin/hooks/register.mjs`.

## 4. Verify, including a live session (required)

- `pnpm lint && pnpm --filter <plugin> build && pnpm --filter <plugin> test` and `claude plugin validate <plugin>/plugin`.
- A real Claude Code session with the built plugin: `claude -p "<prompt that makes the plugin do its job>" --plugin-dir <plugin>/plugin --setting-sources project --allowedTools "<narrow list>"`, once per main path of the plugin (for jev-api: a real tool call, a batch call, an input error, and the Haiku-only path with the endpoint variables unset via `env -u`). The unit tests do not load the bundle through the real engine; only this does.
- Record the sizes again and report before/after.

## 5. Docs and release

- The plugin's `CLAUDE.md`: a "Source layout" bullet naming each module and the bundling; names in other bullets refer to those files.
- Version bump in `<plugin>/package.json` and `pnpm build` (any change under `<plugin>/` needs it, see the root `CLAUDE.md`), PR as usual.

## Pitfalls seen

- A bash command that mentions git and `cd` in one line is refused in a worktree session: put multi-step edits in a script and run plain commands.
- `export` must be added to moved declarations only in helper files, never in the entry (`register`).
- The bundler merges all helper imports of the entry into one `import { ... } from "./lib.mjs"`; if a helper is imported by name from the entry but not exported by its module, the build fails on the generated `export { ... }` or at load time: check the test run.
