---
paths:
  - "*/plugin/**"
---

# Rule: plugin/ = shipped plugin only

Allowed in `plugin/`, nothing else:

- build output (never edit): `**/*.mjs` (minified, from `../src/**/*.mts`), `.claude-plugin/plugin.json` (from `../plugin.json`)
- hand-written: `README.md`, `.mcp.json`, `hooks/hooks.json`, `skills/**/SKILL.md` + `*.reference.md` + data `*.json`, `agents/*.md`

Forbidden: `*.ts`, `*.mts`, `*.d.mts`, `tests/`, `*.test.*`, `CLAUDE.md`, `.gitignore`d engine output. Function-hooks modules too: source in `src/hooks/*.mts`, `hooks.json` lists `./<name>.mjs` (see dprint `notice`). Upstream code in another layout gets converted, never copied 1:1. Never edit this rule to fit a change — fix the change. `pnpm build` and CI fail on violations.

Runtime imports: `node:` builtins only.
