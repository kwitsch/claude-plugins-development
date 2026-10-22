---
name: scaffold-plugin
description: Scaffold a new Claude Code plugin in this repository with the repo layout (<name>/plugin.json, plugin/, src/, tests/, scripts/, package.json). Use when the user asks to create, add, scaffold or start a new plugin here.
argument-hint: "[plugin-name] [one-line description]"
disable-model-invocation: false
---

# scaffold-plugin

Creates `<name>/` at the repo root following the layout in the root `CLAUDE.md`. Never overwrites an existing plugin directory.

## Step 1 — Collect inputs

Use `AskUserQuestion` for anything missing. Parse `$ARGUMENTS` first (`<name> [description]`).

- **name** — kebab-case, `^[a-z][a-z0-9-]*$`. Abort if `<name>/` already exists.
- **description** — one sentence.
- **components** (multi-select): `skill`, `hook`, `agent`, `mcp`. Only `hook` and `mcp` need `src/` TypeScript; the others are plain markdown in `plugin/`.
- **hook event** (if `hook` chosen): e.g. `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`.

## Step 2 — Create the directory tree

From the repo root, copy templates from `${CLAUDE_SKILL_DIR}/templates/` and substitute `__NAME__`, `__DESCRIPTION__`, `__AUTHOR__` (`__AUTHOR__` = current `git config user.name`):

```bash
name=<name>
mkdir -p "$name"/{plugin/.claude-plugin,src,tests,scripts}
T="${CLAUDE_SKILL_DIR}/templates"
for f in plugin.json package.json tsconfig.json; do
  sed -e "s/__NAME__/$name/g" -e "s/__DESCRIPTION__/<description>/g" -e "s/__AUTHOR__/$(git config user.name)/g" "$T/$f" > "$name/$f"
done
cp "$T/build.mjs" "$name/scripts/build.mjs"
sed "s/__NAME__/$name/g" "$T/plugin-CLAUDE.md" > "$name/plugin/CLAUDE.md"
sed "s/__NAME__/$name/g" "$T/README.md" > "$name/plugin/README.md"
```

Per selected component:

- **skill** → `plugin/skills/<skill-name>/SKILL.md` from `templates/SKILL.md` (frontmatter `name`, `description`; body = instructions).
- **hook** → `src/hooks/<event-kebab>.mts` from `templates/hook.mts` and `plugin/hooks/hooks.json` from `templates/hooks.json` (set the event name and the `.mjs` path). Add `tests/<event-kebab>.test.mjs` from `templates/hook.test.mjs`.
- **agent** → `plugin/agents/<agent-name>.md` with frontmatter `name`, `description`, `tools`.
- **mcp** → `src/mcp/server.mts` (zero-dep stdio JSON-RPC) and `plugin/.mcp.json` pointing at `${CLAUDE_PLUGIN_ROOT}/mcp/server.mjs`. Add a test.

If no `src/` files were created, still keep `src/`, `scripts/` and the `package.json` — the build then only syncs `plugin.json`.

## Step 3 — Build and verify

```bash
pnpm install
pnpm --filter <name> build
pnpm --filter <name> test
claude plugin validate <name>/plugin
```

All three must pass. Fix template substitutions, never hand-edit `plugin/**/*.mjs` or `plugin/.claude-plugin/plugin.json`.

## Step 4 — Report

List the created files and the three commands above. Do not commit unless asked.

## Rules recap

- `<name>/plugin.json` is the only place for `version`, `description`, `author`; `pnpm build` copies it to `plugin/.claude-plugin/plugin.json`.
- `src/**/*.mts` → `plugin/**/*.mjs`, same relative path.
- Runtime code: `node:` builtins only.
