---
paths:
  - "src/skills/**"
  - "plugin/skills/**"
  - "tests/skill.test.ts"
---

# Skill `universal-format`

- `plugin/skills/universal-format/` adds the user-only `/universal-format:universal-format` command: a free-text file selector, resolved by Claude into a list file, then the driver `format-files.mjs` (source `src/skills/universal-format/format-files.ts`, built next to the hand-written `SKILL.md` and `format-files.reference.md`).
- The driver holds no formatting logic: per file it calls `formatPre` (imported from `../../mcp/handlers.mjs`) as a Write would and writes the returned content back, so all 17 languages, exclusions and ignore rules are the hook's.
- Fail open per file; exit 0 on every real run (2 only for a missing list file argument); the printed summary is the signal.
- `disable-model-invocation: true`, no `userConfig`; the skill directory names no other plugin (tested).
- `SKILL.md` runs `node ${CLAUDE_SKILL_DIR}/format-files.mjs "<list>"` and must never contain the exclamation-mark-plus-backtick preprocessor sequence (tested).
