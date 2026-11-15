---
paths:
  - "*/src/hooks/**"
  - "*/plugin/hooks/hooks.json"
  - "development/scripts/build-plugin.ts"
---

# Rule: function-hooks plugins ship register.mjs plus one compressed lib.mjs

Preferred for every function-hooks plugin of this repository, to keep the shipped size small (decided with jev-api 0.4.0). Use the skill `split-hooks-lib` to move a plugin over.

- `src/hooks/register.ts` (the module `plugin/hooks/hooks.json` lists) is the entry: built unminified and unmangled, because Claude Code's static check reads it (`$`/`on` spelled as such, named hook functions, literal first arguments such as `$.env.get("NAME")`). Keep those calls in the entry.
- Every other `src/hooks/*.ts` is a helper. With `"pluginBuild": { "bundleHooksLib": true }` in the plugin's `package.json` (top level, not inside `claudePlugin`) `development/scripts/build-plugin.ts` bundles all helpers into one `plugin/hooks/lib.mjs` (compressed, whitespace removed, deliberately not mangled so `$` and engine calls stay spelled) and points the entry's imports at it. Without the flag every `hooks/*.mjs` ships as before.
- Helpers import siblings only as named imports from `./name.mjs`, have no import cycle, declare unique top-level names across all helpers and keep no state at module level (the test kit reloads only the entry per test; state belongs inside `register()`). The build fails with a message on a violation of the first three; module-level state is not detected.
- Tests: `.claude/rules/hook-tests.md`; after the split a real session must be checked too (`claude -p --plugin-dir <plugin>/plugin`), since only the real engine loads the bundle.
- A new function-hooks plugin starts with this layout; a plugin whose hooks module is one small file may stay a single `register.ts`.
- A helper's import binding or top-level name (`setTimeout`, an object-destructure with default) must not shadow a global another helper uses.
- Changing the bundler itself: the import shapes it must be checked against are in `development/CLAUDE.md`.
