# Repository-wide decisions and their reasons

Why the repository is set up the way the root `CLAUDE.md` and the rules describe, so a later session does not reopen a settled question without a new reason.

The rules state what to do; this page states why and what was rejected. All decisions are the user's unless noted.

## Formatting: dprint, minimal config (2026-10-31)

- `dprint.json` is deliberately minimal: 2-space indent, no line-width limit (`lineWidth: 2147483647`, dprint has no "off"), per-language sections `{}`, markdown only `table.minColumnWidth` and `codeBlock.skipFormat`, `**/*.mjs` excluded because it is build output.
- TypeScript is formatted by `@dprint/typescript`. Rejected: the prettier plugin (it was added once and taken out again) and language-specific style rules.
- After a config change, run `dprint fmt` and commit the reformat on its own.

## Lint and type check: one oxlint run at the root (2026-11)

- Tooling is workspace-wide at the repository root; dprint formats, oxc does the rest. `pnpm lint` is the type check; there is no `tsc` and no `typecheck` script ([lint-config.md](../../../.claude/rules/lint-config.md)).
- Doc comments are not linted: oxlint runs natively without JS plugins, so `eslint-plugin-jsdoc` and `eslint-plugin-tsdoc` were dropped. TSDoc is kept up by the rule [tsdoc.md](../../../.claude/rules/tsdoc.md) instead.

## Test runner: vitest (checked 2026-11)

- Stays vitest. Rejected: `node:test` (it would break the portability of `claude-engine-vitest` tests to the official vitest-based `claude-code/testing` kit), rstest (before 1.0), `bun test` (needs the Bun runtime); oxc has no test runner. No ready-made npm package of the engine kit exists (checked 2026-11-04), hence the workspace package.
- Do not re-evaluate without a new reason.

## Sources and build output

- `<name>/package.json` is the only manifest source; `plugin.json` is generated. CI recognises a plugin by the `claudePlugin` key, not by committed build output, so a plugin whose `plugin/` was not committed still gets checked ([ci.md](../../../.claude/rules/ci.md)).
- Hand-written modules are `.ts` because graphmind indexes `.ts` symbols and no `.mts` symbols ([src-typescript.md](../../../.claude/rules/src-typescript.md), 2026-11-15).
- Function-hooks plugins ship a readable `register.mjs` plus one compressed `lib.mjs`, to keep the shipped size small ([hooks-lib-bundle.md](../../../.claude/rules/hooks-lib-bundle.md), 2026-11-14).
- Plugins are developed here and reach users through the marketplace repository `kwitsch/claude-plugins`, where `plugins/<name>` is build output written by the Sync workflow: never edit it there, and it has no tests there.

## Language (2026-11-14)

- Everything written into the repository is English: documents, task files, messages a plugin prints, comments, commit text. The chat language does not carry over.

## Knowledge (2026-11-15)

- A fact has one home. Plugin notes (`<plugin>/CLAUDE.md`, `<plugin>/.claude/rules/`) do not restate root rules and do not leave "moved to" stubs between files that load together.
- Knowledge that fits no rule lives in this wiki (`development/wiki/`), with an index, a log and a lint; rules stay short constraints that load by file path. The repository is the source of truth; the machine-local memory holds personal preferences and pointers. Reason: 217 memory entries and the topic knowledge of nine days of sessions existed on one machine only, unreviewed and invisible to other sessions. Rejected: rules only (topic knowledge has no path), exporting the memory store into the repository (raw, unreviewed notes in every PR), a generated codebase wiki (describes code, not decisions).
- Location `development/wiki/`: next to the other shared developer tooling, outside every plugin directory, so no version bump is involved.
