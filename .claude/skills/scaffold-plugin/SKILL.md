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
sed "s/__NAME__/$name/g" "$T/CLAUDE.md" > "$name/CLAUDE.md"
sed "s/__NAME__/$name/g" "$T/README.md" > "$name/plugin/README.md"
```

Per selected component:

- **skill** → `plugin/skills/<skill-name>/SKILL.md` from `templates/SKILL.md` (frontmatter `name`, `description`; body = instructions).
- **hook** → `src/hooks/<event-kebab>.mts` from `templates/hook.mts` and `plugin/hooks/hooks.json` from `templates/hooks.json` (set the event name and the `.mjs` path). Add `tests/<event-kebab>.test.mts` from `templates/hook.test.mts`.
- **mods** → `src/hooks/register.mts` exporting `register(on, options)` with structural `$`/`on` types (model: `inline-headroom/src/hooks/register.mts`), and `plugin/hooks/hooks.json` `{"modules": ["./register.mjs"]}` (merged into the same file when `hook` is also chosen). Tests in `tests/register.test.mts` with `createKit` from `claude-engine-vitest` (`pnpm --filter <name> add -D claude-engine-vitest@workspace:*`).
- **agent** → `plugin/agents/<agent-name>.md` with frontmatter `name`, `description`, `tools`.
- **mcp** → `src/mcp/server.mts` (zero-dep stdio JSON-RPC) and `plugin/.mcp.json` pointing at `${CLAUDE_PLUGIN_ROOT}/mcp/server.mjs`. Dual-era from the start (answer `initialize` and `server/discover`): follow `.claude/rules/mcp-dual-era.md`, model `dprint/src/mcp/server.mts`. Add a test for both eras.

If no `src/` files were created, still keep `src/` and the `package.json` — the build then only generates `plugin/.claude-plugin/plugin.json` from `package.json`.

## Step 3 — Build and verify

```bash
pnpm install
pnpm --filter <name> build
pnpm exec oxlint
pnpm --filter <name> test
claude plugin validate <name>/plugin
```

All four must pass. Fix template substitutions, never hand-edit `plugin/**/*.mjs` or `plugin/.claude-plugin/plugin.json`.

## Step 4 — Report

List the created files and the three commands above. Do not commit unless asked.

## Rules recap

- `<name>/package.json` is the only place for `version`, `description`, `author`, `keywords` and `claudePlugin` (required, `{}` at least: marks the package as a plugin for CI; holds plugin-only manifest fields such as `userConfig`); `pnpm build` generates the manifest `plugin/.claude-plugin/plugin.json`.
- `src/**/*.mts` → `plugin/**/*.mjs`, same relative path.
- Scripts used by several components (skills, hooks, MCP) go in `src/bin/*.mts` → `plugin/bin/*.mjs`.
- Runtime code: `node:` builtins only.
