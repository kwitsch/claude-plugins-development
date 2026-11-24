---
name: scaffold-plugin
description: Scaffold a new Claude Code plugin in this repository with the repo layout (<name>/package.json, assets/, src/, tests/). Use when the user asks to create, add, scaffold or start a new plugin here.
argument-hint: "[plugin-name] [one-line description]"
disable-model-invocation: false
---

# scaffold-plugin

Creates `<name>/` at the repo root following the layout in the root `CLAUDE.md`. Never overwrites an existing plugin directory.

## Step 1 — Collect inputs

Use `AskUserQuestion` for anything missing. Parse `$ARGUMENTS` first (`<name> [description]`).

- **name** — kebab-case, `^[a-z][a-z0-9-]*$`. Abort if `<name>/` already exists.
- **description** — one sentence.
- **components** (multi-select): `skill`, `hook` (command hook), `mods` (function-hooks module), `agent`, `mcp`. Only `hook`, `mods` and `mcp` need `src/` TypeScript; the others are plain markdown in `assets/`.
- **hook event** (if `hook` chosen): e.g. `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`.

## Step 2 — Create the directory tree

From the repo root, copy templates from `${CLAUDE_SKILL_DIR}/templates/` and substitute `__NAME__`, `__DESCRIPTION__`, `__AUTHOR__` (`__AUTHOR__` = current `git config user.name`):

```bash
name=<name>
mkdir -p "$name"/{assets,src,tests}
T="${CLAUDE_SKILL_DIR}/templates"
sed -e "s/__NAME__/$name/g" -e "s/__DESCRIPTION__/<description>/g" -e "s/__AUTHOR__/$(git config user.name)/g" "$T/package.json" > "$name/package.json"
cp "$T/tsdown.config.ts" "$name/tsdown.config.ts"
sed "s/__NAME__/$name/g" "$T/CLAUDE.md" > "$name/CLAUDE.md"
sed "s/__NAME__/$name/g" "$T/README.md" > "$name/assets/README.md"
mkdir -p "development/wiki/plugins/$name"
sed "s/__NAME__/$name/g" "$T/wiki-index.md" > "development/wiki/plugins/$name/index.md"
```

In `$name/tsdown.config.ts`, delete the `hooksTemplate` line when neither `hook` nor `mods` was chosen and the `mcpTemplate` line when `mcp` was not chosen. The build is the published preset `@kwitsch/tsdown-preset-claude-code` (`.claude/rules/tsdown-build.md`); hand-written shipped files go in `assets/` at their `plugin/` path, never in `plugin/` (the build empties it).

Then add `- [<name>](<name>/index.md): <description>` to `development/wiki/plugins/index.md` (alphabetical). Every plugin has a wiki section with its own `index.md`, linked from there; `wiki-check.ts` (part of `pnpm lint`) fails without it. A task list `TASKS.md` is added only when a worklist exists (format: `.claude/rules/plugin-docs-tasks.md`).

Per selected component:

- **skill** → `assets/skills/<skill-name>/SKILL.md` from `templates/SKILL.md` (frontmatter `name`, `description`; body = instructions). A skill script is `src/skills/<skill-name>/<script>.ts` (line 1 `#!/usr/bin/env node`), listed in `tsdown.config.ts` as `scripts: { skills: { "<skill-name>": ["src/skills/<skill-name>/<script>.ts"] } }` and built to `plugin/skills/<skill-name>/<script>.mjs`; the SKILL.md must name `<script>.mjs`.
- **hook** → `src/hooks/<event-kebab>.ts` from `templates/hook.ts` (line 1 stays `#!/usr/bin/env node`) and `hooks.template.json` from `templates/hooks.template.json` (substitute `__EVENT__` and `__EVENT_KEBAB__`). The build writes `plugin/hooks/<event-kebab>.mjs` and a `plugin/hooks/hooks.json` that starts it as `"command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/hooks/<event-kebab>.mjs"]`. Add `tests/<event-kebab>.test.ts` from `templates/hook.test.ts`.
- **mods** → `src/hooks/register.ts` exporting `register(on, options)` with structural `$`/`on` types (model: `graphmind-helper/src/hooks/register.ts`); `hooks.template.json` gets `"mod": "./src/hooks/register.ts"` (the whole file `{ "mod": "./src/hooks/register.ts" }`, or the key beside `hooks` when `hook` is also chosen). Built to `plugin/hooks/register.js`; the generated `hooks.json` lists `./register.js`. Unit tests in `tests/register.test.ts` with `createKit` from `claude-engine-vitest` bound to `src/hooks/register.ts` (`new URL("../src/hooks/register.ts", import.meta.url)`; `pnpm --filter <name> add -D claude-engine-vitest@workspace:*`). Integration tests: `mkdir -p "$name/claude-tests"`, `sed "s/__NAME__/$name/g" "$T/claude-test.ts" > "$name/claude-tests/register.test.ts"`, and add `"test:plugin": "node ../development/scripts/plugin-test.ts"` to the `scripts` of `<name>/package.json` (`.claude/rules/hook-tests.md`).
- **agent** → `assets/agents/<agent-name>.md` with frontmatter `name`, `description`, `tools`.
- **mcp** → `src/bin/mcp.ts` (zero-dep stdio JSON-RPC, line 1 `#!/usr/bin/env node`) and `mcp.template.json` = `{ "mcpServers": { "<name>": { "command": "./src/bin/mcp.ts" } } }`; built to `plugin/mcp/mcp.mjs`, and the generated `.mcp.json` starts it with `node`. Dual-era from the start (answer `initialize` and `server/discover`): follow `.claude/rules/mcp-dual-era.md`. Add a test for both eras.

If none of `hook`, `mods` and `mcp` was chosen there is no source entry, and the standard has no build for such a plugin (`development/wiki/decisions/tsdown-plugin-build.md`, "Skills-only plugins"): stop and report that a skills-only plugin is not supported yet.

## Step 3 — Build and verify

```bash
pnpm install
pnpm --filter <name> build   # Node 26
pnpm exec oxlint
pnpm --filter <name> test
pnpm --filter <name> test:plugin   # mods only (needs claude)
claude plugin validate <name>/plugin
```

All must pass (`test:plugin` only for mods). Fix template substitutions; never edit anything under `plugin/` (the build empties and regenerates it).

## Step 4 — Report

List the created files and the commands above. Do not commit unless asked.

## Rules recap

- `<name>/package.json` is the only place for `version`, `description`, `author`, `keywords` and `claudePlugin` (required, `{}` at least: marks the package as a plugin for CI; holds plugin-only manifest fields such as `userConfig`); `tsdown.config.ts` forwards `claudePlugin` as the preset's `manifest`, and `pnpm build` generates `plugin/.claude-plugin/plugin.json`.
- Only the entries named in `hooks.template.json`, `mcp.template.json` and `scripts` of `tsdown.config.ts` are built, each into one self-contained file; every other `src/` module is inlined (`.claude/rules/tsdown-build.md`). Template commands are relative `.ts` paths without arguments.
- Scripts used by several components (skills, hooks, MCP) go in `src/bin/<name>.ts`, listed under `scripts: { bin: [...] }` → `plugin/bin/<name>.mjs`.
- Runtime code: `node:` builtins only.
- New sources are `.ts`: a relative import reads `./x.js` (the build inlines it). Tests follow `.claude/rules/hook-tests.md`: a function-hooks plugin binds `claude-engine-vitest` to `src/hooks/register.ts` (a shared kit in `tests/support/` once it has several test files) and runs `claude-tests/` on the built plugin with `pnpm --filter <name> test:plugin`; a command hook spawns its built `.mjs`.
