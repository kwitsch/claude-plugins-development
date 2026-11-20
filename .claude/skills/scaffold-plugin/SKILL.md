---
name: scaffold-plugin
description: Scaffold a new Claude Code plugin in this repository with the repo layout (<name>/package.json, plugin/, src/, tests/). Use when the user asks to create, add, scaffold or start a new plugin here.
argument-hint: "[plugin-name] [one-line description]"
disable-model-invocation: false
---

# scaffold-plugin

Creates `<name>/` at the repo root following the layout in the root `CLAUDE.md`. Never overwrites an existing plugin directory.

## Step 1 — Collect inputs

Use `AskUserQuestion` for anything missing. Parse `$ARGUMENTS` first (`<name> [description]`).

- **name** — kebab-case, `^[a-z][a-z0-9-]*$`. Abort if `<name>/` already exists.
- **description** — one sentence.
- **components** (multi-select): `skill`, `hook` (command hook), `mods` (function-hooks module), `agent`, `mcp`. Only `hook`, `mods` and `mcp` need `src/` TypeScript; the others are plain markdown in `plugin/`.
- **hook event** (if `hook` chosen): e.g. `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`.

## Step 2 — Create the directory tree

From the repo root, copy templates from `${CLAUDE_SKILL_DIR}/templates/` and substitute `__NAME__`, `__DESCRIPTION__`, `__AUTHOR__` (`__AUTHOR__` = current `git config user.name`):

```bash
name=<name>
mkdir -p "$name"/{plugin/.claude-plugin,src,tests}
T="${CLAUDE_SKILL_DIR}/templates"
sed -e "s/__NAME__/$name/g" -e "s/__DESCRIPTION__/<description>/g" -e "s/__AUTHOR__/$(git config user.name)/g" "$T/package.json" > "$name/package.json"
sed -e 's#__MODS__#<mods>#' -e 's#__SCRIPTS__#<scripts>#' "$T/tsdown.config.ts" > "$name/tsdown.config.ts"
sed "s/__NAME__/$name/g" "$T/CLAUDE.md" > "$name/CLAUDE.md"
sed "s/__NAME__/$name/g" "$T/README.md" > "$name/plugin/README.md"
mkdir -p "development/wiki/plugins/$name"
sed "s/__NAME__/$name/g" "$T/wiki-index.md" > "development/wiki/plugins/$name/index.md"
```

`<mods>` and `<scripts>` are the comma-separated, double-quoted entries of the chosen components (empty when none): `mods` gives the mod entry `"hooks/register"`; `hook` gives the script entry `"hooks/<event-kebab>"`; `mcp` gives the script entry `"bin/mcp"`. Entries are paths below `src/` without extension (`.claude/rules/tsdown-build.md`).

Then add `- [<name>](<name>/index.md): <description>` to `development/wiki/plugins/index.md` (alphabetical). Every plugin has a wiki section with its own `index.md`, linked from there; `wiki-check.ts` (part of `pnpm lint`) fails without it. A task list `TASKS.md` is added only when a worklist exists (format: `.claude/rules/plugin-docs-tasks.md`).

Per selected component:

- **skill** → `plugin/skills/<skill-name>/SKILL.md` from `templates/SKILL.md` (frontmatter `name`, `description`; body = instructions).
- **hook** → `src/hooks/<event-kebab>.ts` from `templates/hook.ts` (line 1 stays `#!/usr/bin/env node`), listed under `scripts` as `hooks/<event-kebab>`, and `plugin/hooks/hooks.json` from `templates/hooks.json` (set the event name and the `.mjs` path). Add `tests/<event-kebab>.test.ts` from `templates/hook.test.ts`.
- **mods** → `src/hooks/register.ts` exporting `register(on, options)` with structural `$`/`on` types (model: `graphmind-helper/src/hooks/register.ts`), listed under `mods` as `hooks/register` and built to `plugin/hooks/register.js`; `plugin/hooks/hooks.json` is `{"modules": ["./register.js"]}` (merged into the same file when `hook` is also chosen). Tests in `tests/register.test.ts` with `createKit` from `claude-engine-vitest` bound to `plugin/hooks/register.js` (`pnpm --filter <name> add -D claude-engine-vitest@workspace:*`).
- **agent** → `plugin/agents/<agent-name>.md` with frontmatter `name`, `description`, `tools`.
- **mcp** → `src/bin/mcp.ts` (zero-dep stdio JSON-RPC, line 1 `#!/usr/bin/env node`), listed under `scripts` as `bin/mcp` and built to `plugin/bin/mcp.mjs`, and `plugin/.mcp.json` pointing at `${CLAUDE_PLUGIN_ROOT}/bin/mcp.mjs`. Dual-era from the start (answer `initialize` and `server/discover`): follow `.claude/rules/mcp-dual-era.md`. Add a test for both eras.

If none of `hook`, `mods` and `mcp` was chosen there is no source entry, and the tsdown standard has not decided that case yet (`development/wiki/decisions/tsdown-plugin-build.md`, "Coexistence and the last migration"): delete `<name>/tsdown.config.ts`, set the `build` script in `<name>/package.json` to `node ../development/scripts/build-plugin.ts` (it then only generates `plugin/.claude-plugin/plugin.json`), keep `src/`, and say so in the report.

## Step 3 — Build and verify

```bash
pnpm install
pnpm --filter <name> build
pnpm exec oxlint
pnpm --filter <name> test
claude plugin validate <name>/plugin
```

All four must pass. Fix template substitutions, never hand-edit `plugin/**/*.mjs`, `plugin/hooks/*.js` or `plugin/.claude-plugin/plugin.json`.

## Step 4 — Report

List the created files and the three commands above. Do not commit unless asked.

## Rules recap

- `<name>/package.json` is the only place for `version`, `description`, `author`, `keywords` and `claudePlugin` (required, `{}` at least: marks the package as a plugin for CI; holds plugin-only manifest fields such as `userConfig`); `pnpm build` generates the manifest `plugin/.claude-plugin/plugin.json`.
- Only the entries listed in `<name>/tsdown.config.ts` are built, each into one self-contained file: mods `src/hooks/register.ts` → `plugin/hooks/register.js`, scripts `src/<entry>.ts` → `plugin/<entry>.mjs`; every other `src/` module is inlined (`.claude/rules/tsdown-build.md`).
- Scripts used by several components (skills, hooks, MCP) go in `src/bin/<name>.ts`, listed under `scripts` → `plugin/bin/<name>.mjs`.
- Runtime code: `node:` builtins only.
- New sources are `.ts`, never `.mts` (`.claude/rules/src-typescript.md`): a relative import reads `./x.js` (the build inlines it). Tests follow `.claude/rules/hook-tests.md`: a function-hooks plugin binds `claude-engine-vitest` to `plugin/hooks/register.js` (a shared kit in `tests/support/` once it has several test files), a command hook spawns its built `.mjs`.
