---
name: convert-plugin-ts
description: Convert one plugin of this repository from .mts to .ts sources and tests, including the test standard (unit tests import src/ through a shared kit bound to src/hooks/register.ts), in a worktree with every check of .claude/rules/src-typescript.md. Use when the user asks to convert, migrate or switch a plugin to .ts, or when a change touches a plugin that still holds .mts under src/ or tests/.
argument-hint: "<plugin-name>"
---

# convert-plugin-ts

Derived from two real conversions (jev-api, jevfort) and the rules `.claude/rules/src-typescript.md` and `.claude/rules/hook-tests.md`. The first change in a plugin that still holds `.mts` includes this conversion, not a follow-up. The argument is the plugin directory name. Stop with one line if `<plugin>/src` and `<plugin>/tests` hold no `.mts`. Work in a worktree on a `feat/` branch (`EnterWorktree`, never nest).

Why `.ts`: graphmind indexes `.ts` symbols but not `.mts`. Why the kit: one shared fake environment per plugin; the built output is covered by `claude-tests/` (`.claude/rules/hook-tests.md`).

## 0. Baseline

- `pnpm lint` and `pnpm --filter <plugin> test` must pass first; note the number of tests (the end check compares it).
- `git status -- <plugin>/plugin` is clean. Commit or set aside nothing of the user's.

## 1. Rename and rewrite the imports

- `<plugin>/src/**/*.mts` and `<plugin>/tests/**/*.mts` to `.ts` (plain `mv`; `scripts/*.mts` of the plugin stay `.mts`, Node runs them; `.d.mts` becomes `.d.ts`).
- In `src/` only: a relative import `from "./x.mjs"` becomes `from "./x.js"` (TypeScript resolves `.js` to `x.ts`; the build rewrites it back to `./x.mjs`). In `tests/`, imports of `src/` name the real `.ts` file (`../src/bin/common.ts`); built `plugin/...mjs` names that a spawned process or a fixture string uses stay.
- References by file name: tests that read a source (`new URL("../src/....mts", ...)`), the plugin's `CLAUDE.md`, rules and comments that name `x.mts`. Leave the names of plugins that are still `.mts` (dprint, graphmind-helper, universal-lint) alone.
- Put long edits in a script in the session scratchpad and run plain commands: a worktree session refuses compound shell commands with quoting, heredocs and `git`.

## 2. The build proves the rename

`pnpm --filter <plugin> build`, then `git status -- <plugin>/plugin` must be empty: the shipped `.mjs` are byte-identical. If not, the build script is wrong and every later plugin would hit it: stop and fix `development/scripts/build-plugin.ts` first. Then `pnpm lint` (typed sources show new findings, usually fixture fields; fix them in the fixture, no casts) and `pnpm --filter <plugin> test`.

## 3. Bundle the hooks if the plugin has a function-hooks module

Follow `.claude/rules/hooks-lib-bundle.md` (old build; the sources must already be `.ts`). Helpers that tests imported from `plugin/hooks/<helper>.mjs` disappear into `lib.mjs`: step 4 moves those imports to `src/`.

## 4. Move the tests to the standard

Follow `.claude/rules/hook-tests.md`. Procedure that worked:

1. List the test files and what each imports; every import of `plugin/` moves to `src/` (except a spawned process and a shipped file a test reads, such as `plugin/.mcp.json`).
2. `tests/support/kit.ts` from [templates/kit.ts](templates/kit.ts) (binds the kit to `src/hooks/register.ts`; see `graphmind-helper/tests/support/kit.ts` for a full one: tool list and calls, `process.run`, fs, env, toast). Each test file calls `makeKit(options)`; no copies of the fakes.
3. A pure helper is tested from its `src/` file or through the hook that makes it visible: an effort or decision as the tool result, the request and recent steps in the state of a question, the offered options as the criteria of a question, the band, `session.compact`. Tables of rows for like cases, one `setup()` per test, state the fake reads at call time for several cases.
4. An assertion with no hook-level equivalent is not dropped silently: a comment at the nearest test says what was lost and why. No placeholder tests.
5. Count: tests before and after; say in the commit message what changed on purpose.
6. `pnpm lint`, `pnpm --filter <plugin> test`, and the whole `pnpm -r test` once (a failure that only shows in the parallel run is checked alone and repeated before anything is changed).

## 5. Check outside the unit tests (required)

- `claude plugin validate <plugin>/plugin`.
- A live session: skill `live-verify`; `claude -p --plugin-dir <plugin>/plugin --setting-sources project` with a prompt that makes the plugin do its job. A plugin that needs jev-api loads both plugin dirs.
- `graphmind build` in the worktree, then `graphmind outline <plugin>/src/hooks/register.ts`: functions with typed signatures listed. A file with only constants lists nothing; that is graphmind, not the conversion.
- A failure here means the build script, not the plugin.

## 6. Docs, release, report

- The plugin's `CLAUDE.md` (file names, test setup). No status list: the rule file states no progress, `git ls-files '<plugin>/src/*.mts'` shows what is left.
- Version bump in `<plugin>/package.json` and `pnpm --filter <plugin> build` (a change under `<plugin>/` needs one, see the root `CLAUDE.md`); `plugin.json` comes from the build, never by hand.
- Commit in logical steps (rename and imports, hooks bundle, tests, docs). Open or update the PR; report the checks of step 5, the test counts and what was not exercised.

## Pitfalls seen

- A merge conflict in a generated `plugin/.claude-plugin/plugin.json`: resolve `package.json`, then rebuild; the manifest is not edited directly.
- dprint reformats a file on write; re-read before string-based edits, and a classifier may refuse a write whose content a hook changed (do not route around it, say so).
- `pnpm install` for a throwaway plugin changes `pnpm-lock.yaml`: restore it before committing.
- `npm install` in a plugin directory fails on `workspace:*`; the repo uses pnpm.
