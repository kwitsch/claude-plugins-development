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

## Vendored third-party bundles (2026-11-17)

- `plugin/` may hold a vendored third-party bundle `**/vendor/*.mjs` and the binary files it loads, listed by exact path under `pluginBuild.assets` ([plugin-build-output.md](../../../.claude/rules/plugin-build-output.md)). User decision with the migration of universal-format, the only plugin that uses it: its prettier and the java, php and shell plugins cannot be zero-dependency sources, and a plugin runs from a cache copy without `node_modules` and without an install step.
- The bundler is rolldown (root devDependency, exact pin), run by the plugin's own `scripts/vendor.ts` after the standard build; the plugin's own code still goes through `build-plugin.ts` file by file. The output is code-split and minified without comments, so it is the same on every machine and CI's freshness check covers it.
- Rejected: bun as the bundler (as a devDependency it did not install cleanly, and CI could not rebuild the bundle: the old repository checked freshness by a fingerprint banner instead), one bundle holding own and third-party code (own code would leave the standard build and its type-stripped one-file-per-source layout), a general `plugin/**` allowlist for binary files (an exact list per plugin keeps the layout check an allowlist), installing dependencies at runtime.
- The bundled packages are ignored by Dependabot: a bump changes `plugin/` and needs a version bump of the plugin, so it is done by hand.

## Language (2026-11-14)

- Everything written into the repository is English: documents, task files, messages a plugin prints, comments, commit text. The chat language does not carry over.

## Knowledge (2026-11-15)

- A fact has one home. Plugin notes (`<plugin>/CLAUDE.md`, `<plugin>/.claude/rules/`) do not restate root rules and do not leave "moved to" stubs between files that load together.
- Knowledge that fits no rule lives in this wiki (`development/wiki/`), with an index, a log and a lint; rules stay short constraints that load by file path. The repository is the source of truth; the machine-local memory holds personal preferences and pointers. Reason: 217 memory entries and the topic knowledge of nine days of sessions existed on one machine only, unreviewed and invisible to other sessions. Rejected: rules only (topic knowledge has no path), exporting the memory store into the repository (raw, unreviewed notes in every PR), a generated codebase wiki (describes code, not decisions).
- Location `development/wiki/`: next to the other shared developer tooling, outside every plugin directory, so no version bump is involved.

## Memory files hold constraints only (2026-11-15)

- Rules and `CLAUDE.md` files keep each constraint in a line or two and link to a page with the reasons, measurements, residuals and rejected alternatives. Plugin-specific pages live in `plugins/<plugin>/design/` of this wiki, cross-plugin ones in the other wiki folders. Links are plain markdown links; an `@path` import would load the page anyway.
- Reason, measured from the transcripts of ten days (2026-11-05 to 2026-11-15): 46 million characters of memory files were loaded on demand, 97% by subagents; a subagent took in 32k characters at the median and 63k at the 90th percentile. Reading one hooks source loaded 40k to 110k characters.
- First pass (root rules and universal-lint), characters loaded when one file is read, before and after: `universal-lint/src/hooks/lint-file.ts` 109,919 to 39,045; a hooks source of jev-api, jevfort or dprint 41-44k to 32-35k; an MCP server source 37-39k to 25-28k; a jevfort test 34,848 to 21,743. The always-loaded root `CLAUDE.md` grew from 5,358 to 5,863.
- How: paths narrowed where a rule loaded too broadly (`lint-config.md`, `src-typescript.md`, `hook-file-safety.md`, `mcp-dual-era.md`); the shell-porting rule became a wiki page; the mods-engine and MCP rules kept their constraints and moved the detail to `facts/`; universal-lint's 13 hook rules moved unchanged to `development/wiki/plugins/universal-lint/design/` behind one constraints rule.
- Accepted risk: a linked page is read only when the agent judges it relevant, so a constraint that is missing from the rule is not protected. Every moved topic therefore keeps its constraint line in the rule, and the rule says to read the design page before changing that area.
- Rejected: `@path` imports (no saving), deleting the history (it is what stops a later session from undoing a deliberate choice), a per-plugin folder inside the wiki (rejected on 2026-11-15, reversed on 2026-11-16: the plugins' `docs/` directories moved to `plugins/<plugin>/` at the user's request, so that a plugin directory holds only what ships or builds).
- Not done yet: jevfort, jev-api, inline-headroom (57k for `policy.mts`), dprint and graphmind-helper.
