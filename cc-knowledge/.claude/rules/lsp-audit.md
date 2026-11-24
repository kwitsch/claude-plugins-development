---
paths:
  - "assets/skills/lsp-audit/**"
  - "src/skills/lsp-audit/**"
---

# lsp-audit

Mechanics are in `SKILL.md` and `assets/skills/lsp-audit/audit-lsp.reference.md` (script contract, write order, fail-closed cases), not restated here.

- All scan, diff, merge and safe-write logic stays in `src/skills/lsp-audit/scripts/audit-lsp.ts`; `SKILL.md` only orchestrates and gates.
- Write scope is `<project-root>/.claude/skills/lsp/` plus one deletion outside it: a migrated legacy root `.lsp.json`. Widening it needs a deliberate design decision.
- Additive-only and fail-closed: never remove, rewrite or reorder existing config; write nothing on malformed or conflicting JSON.
- Extensions the catalog does not know stay manual to-dos; never guess a server.
- The catalog `lsp-map.json` is operational data (like universal-lint's linter map), not duplicated `cc-reference` knowledge. A server whose `command` is a plain binary (not `npx`) also needs a `tool-map.json` entry and an `install_<id>` recipe in `repository-audit` (see its rule), else detection reports the binary as a manual to-do and `init-dev-environment` cannot install it.
