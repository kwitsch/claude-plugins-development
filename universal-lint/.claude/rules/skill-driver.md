---
paths:
  - "src/skills/**"
  - "plugin/skills/**"
  - "tests/skill.test.mts"
---

# Skill design (`universal-lint`)

- `plugin/skills/universal-lint/` adds the user-only `/universal-lint:universal-lint` command: a free-text file selector → colocated `lint-files.mjs` driver (source `src/skills/universal-lint/lint-files.mts`, built next to the hand-written `SKILL.md` and `lint-files.reference.md`).
- The driver imports `lintFileHandler` (exported from `hooks/lint-file.mjs`, i.e. `../../hooks/lint-file.mjs` from the built skill dir) and calls it per file, collecting each `hookSpecificOutput.additionalContext` into one aggregated, read-only report.
  - The hook's stdin entry point (`main()`) stays the hook's sole entry; the export is the one additive hook for the driver. `isMainModule()` keeps the import from starting the stdin read.
  - Importing the handler bypasses the 5s debounce (which lives only in `main()`/`debounceGate`, not the handler), so the hook's debounce-window env override is irrelevant here (a test asserts the skill dir never mentions it).
- Read-only — the driver never runs an autofix path.
- Per-file fail-open; always exits 0 (2 only for a missing `<listfile>` argument).
- `disable-model-invocation: true` (user-invoke-only); no `userConfig`. The skill dir is self-contained: no references to other plugins (tested).
- Invocation contract in `plugin/skills/universal-lint/lint-files.reference.md`; `SKILL.md` calls `node ${CLAUDE_SKILL_DIR}/lint-files.mjs "$LIST"` and must never contain the exclamation-mark-plus-backtick preprocessor sequence (tested).
