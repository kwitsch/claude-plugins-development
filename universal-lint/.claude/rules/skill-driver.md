---
paths:
  - "src/skills/**"
  - "plugin/skills/**"
  - "tests/skill.test.mts"
---

# Skill design (`universal-lint`)

- `plugin/skills/universal-lint/` adds the user-only `/universal-lint:universal-lint` command: a free-text file selector → colocated `lint-files.mjs` driver (source `src/skills/universal-lint/lint-files.mts`, built next to the hand-written `SKILL.md` and `lint-files.reference.md`).
- The driver imports `lintFilesHandler` (exported from `hooks/lint-file.mjs`, i.e. `../../hooks/lint-file.mjs` from the built skill dir) and passes it the whole resolved list; it prints the returned blocks joined by a blank line, then `universal-lint: N block(s) with findings.` (or `universal-lint: no findings.`).
  - `lintFilesHandler` scopes every file once (one `realish(cwd)`, duplicates linted once), plans each with the hook's own helpers (`chainEntryFor`, `planChainLint`: registry, no-config gates, `selectLintTool`, `buildArgv`) and groups files by tool, local bin, spawn cwd and argv minus the file target (go/cargo: full argv, one run per package dir / crate). One `runLintTool` spawn per group chunk of at most `BATCH_MAX_FILES` (100) files, classified by `chainOutcome`; tsc once per resolved tsconfig via `runTypeCheck`. No `coalesceProjectCheck`, no edit-range gate (whole-file, `gateFinding` not called).
  - Report: one block per tool run, `universal-lint: <tool> found issues in <targets>:` naming every file of the run, also those the tool found clean; batched output is the tool's own, not split per file.
  - A multi-file chunk with a skip verdict reruns its files one at a time (at most `BATCH_MAX_FILES` single spawns per chunk, each under the unchanged per-spawn timeout; no bisect); a spawn error, signal or timeout on a multi-file chunk triggers the same per-file rerun (a single file that still fails or times out is dropped, as the per-file driver dropped it).
  - The hook's stdin entry point (`main()`) stays the hook's sole entry; `lintFilesHandler` is the driver's one additive hook export (`lintFileHandler` stays exported for `main` and tests). `isMainModule()` keeps the import from starting the stdin read.
- Read-only — the driver never runs an autofix path.
- Fail-open per file, chunk and tsconfig group; always exits 0 (2 only for a missing `<listfile>` argument).
- `disable-model-invocation: true` (user-invoke-only); no `userConfig`. The skill dir is self-contained: no references to other plugins (tested).
- Invocation contract in `plugin/skills/universal-lint/lint-files.reference.md`; `SKILL.md` calls `node ${CLAUDE_SKILL_DIR}/lint-files.mjs "$LIST"` and must never contain the exclamation-mark-plus-backtick preprocessor sequence (tested).
