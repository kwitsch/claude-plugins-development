# Log

Append-only; newest entry last. One entry per ingest or lint pass (`grep '^## \[' log.md` lists them).

## [2026-11-15] ingest | First fill from the machine-local memory

Source: the 217 entries of the graphmind project memory and the 8 auto-memory files, written by sessions between 2026-10-31 and 2026-11-15, plus this day's work on universal-lint F40. Every entry was treated as a claim; nothing was copied unchecked.

- **Cross-plugin knowledge** went into the pages of this wiki: nine `facts/` pages, `decisions/repo-tooling.md`, three `methods/` pages, two `pitfalls/` pages. Facts keep the stamp of how they were established at the time (live, binary read, typings, docs); they were not re-verified in this pass, except where noted below.
- **Plugin-specific notes** were checked against each plugin's current code and documents and, where still true and not yet written down, added to that plugin's own files:
  - jev-api (45 notes): 18 already documented, 4 added (`jev-api/CLAUDE.md`, `hooks-source.md`, `http-mcp-server.md`), 2 outdated, 21 general.
  - jevfort (53): 17 already documented, 6 added (a "Standing user decisions" section in `jevfort/CLAUDE.md`; `effort-routing.md`, `cache-compact.md`, `register-hooks.md`), 8 outdated, 22 general.
  - universal-lint (54): 35 already documented, 2 added (`hook-design.md`), 11 outdated, 4 general, 2 left open.
  - dprint and inline-headroom (31): 12 already documented, 4 added (`dprint/CLAUDE.md`, dprint `mcp-server.md`, inline-headroom `register-hooks.md`), 4 outdated, 11 general.
- **Not filed:** personal preferences of the user and facts about one machine's environment (they stay in the machine-local memory); notes about the marketplace repository's own files; claims nobody could verify.
- **Re-verified live in this pass** (2.1.325, headless): the working directory a hook sees in a session started from a symlinked directory. The older note was right (the payload carries the real path), the rule `hook-file-safety.md` was wrong on that point and was corrected.
- **Corrected while filing:** `development/wiki/plugins/universal-lint/design/hook-design.md` said findings appear in transcripts as `hook_blocking_error` attachments; that holds for headless runs only.
- **Found and left open** (outside the scope of an ingest, reported to the user):
  - `jev-api`: `logOutage` passes `$.ui.log` a text that starts with the plugin name, which the engine adds as well; not verified live.
  - `development/wiki/plugins/universal-lint/README.md` says to move a finished task to the "Done" section of `TASKS.md`; `TASKS.md` closes tasks in place. The same file and the `TASKS.md` notes still say "F01-F39".
  - `inline-headroom`: README and `policy-dedup-elider.md` say a compaction empties the dedup corpus; the `session.compact` hook that does it is bypassed on 2.1.325.
  - `dprint/tests/mcp-format.test.ts` leaves one temp directory behind; dprint `skill-scripts.md` lists `README.md` under `paths:`, which matches nothing.
  - `development/wiki/plugins/jevfort/TASKS.md` cites a known limit that no longer exists.

## [2026-11-15] ingest | Memory files slimmed to constraints: root rules and universal-lint

Source: a measurement of on-demand memory loads in the transcripts of ten days and the user's decision of the same day (`decisions/repo-tooling.md`, "Memory files hold constraints only").

- **Moved into the wiki:** the rule `shell-port-pitfalls.md` as `pitfalls/porting-shell-to-node.md`; the protocol detail of `mcp-dual-era.md` as `facts/mcp-protocol-eras.md`; the explanations and evidence of `claude-code-hook-facts.md` into the four `facts/mods-engine-*.md` pages. The rules keep the constraints and link to the pages.
- **Paths narrowed:** `lint-config.md` (config files only), `src-typescript.md` (`.mts` files and the conversion skill), `hook-file-safety.md` (no tests), `mcp-dual-era.md` (no `hooks.json`). Build-script notes moved from `plugin-src.md` and `hooks-lib-bundle.md` to `development/CLAUDE.md`.
- **universal-lint:** its 13 hook rule files moved unchanged (frontmatter removed) to `development/wiki/plugins/universal-lint/design/`; the new rule `universal-lint/.claude/rules/lint-file.md` holds the constraints per area and names each design page. References in 28 markdown files were repointed.
- **Check:** `wiki-check.ts` now also fails on a dead relative link in any `CLAUDE.md` or rule file.
- **Left open:** comments in `universal-lint/src/` still name the design pages as `.claude/rules/<name>.md` (a comment-only source change would force a release); the other plugins' rule files are not slimmed yet.

## [2026-11-16] ingest | Plugin docs moved into the wiki

Source: user request. The `docs/` directories of dprint, inline-headroom, jev-api, jevfort and universal-lint (144 files) moved with `git mv` to `plugins/<plugin>/` (`docs/design/` became `design/`).

- **Repointed:** relative links and path references in the moved pages, the plugin `CLAUDE.md` files and rules, the root `CLAUDE.md`, the skills `perf-worklist`, `bughunt`, `live-verify` and `wiki`, `.coderabbit.yaml` and `plugin-docs-tasks.md` (`paths:` now `development/wiki/plugins/**`).
- **Check:** `wiki-check.ts` requires only each plugin's `README.md` in the index; its other pages are reached from it and need no `# Title` (task files start with frontmatter). Dead links in them still fail.
- **Decision reversed:** `decisions/repo-tooling.md` rejected a per-plugin folder in the wiki on 2026-11-15; the user asked for it on 2026-11-16.

## [2026-11-16] ingest | Plugin sections: own index.md each, one TASKS.md standard

Source: user request.

- **Index:** every plugin has a section `plugins/<plugin>/index.md` (the former `README.md` of dprint, jev-api, jevfort and universal-lint, now with a generated "Pages" list; new ones for inline-headroom, graphmind-helper and jev-solver). `plugins/index.md` links all of them, the root index links only `plugins/index.md`. `wiki-check.ts` enforces both levels and that every plugin of the repository has a section; the `scaffold-plugin` skill creates the section.
- **Task lists:** the four `TASKS.md` files were regenerated from the `tasks/` frontmatter into one format (sections Remaining, Done, Closed without code; one entry line with status tag and priority; the task title replaces the former free-text descriptions, which live in the task documents). Header prose, Dependencies and Notes were kept. `wiki-check.ts` compares each `TASKS.md` with the frontmatter. Format: `.claude/rules/plugin-docs-tasks.md`.

## [2026-11-16] ingest | Plugin sections: one layout, enforced

Source: user request after a structure review of `plugins/`.

- **Layout:** `index.md`, `TASKS.md` + `tasks/`, `evaluations/EVALUATION-<date>[-<topic>].md`, `design/`, `notes/` (rule `.claude/rules/plugin-docs-tasks.md`). Moved: all evaluations into `evaluations/` (jevfort `-2`, `-3`, `-F01`, `-F04` became `-worklist`, `-option-removal`, `-f01`, `-f04`; universal-lint `14b` became `-v0.16.1`), `HAIKU-CALIBRATION.md` and the two inline-headroom pages into `notes/` (lower case). Evaluation headings unified to Method, Results, Bug hunt, Live validation. The plugin `index.md` Pages lists were regenerated.
- **Check:** `wiki-check.ts` rejects other files in a section, requires the four evaluation headings, the task headings Status, Problem and Related, `## Pages` as the first section of an `index.md` and `## How to work a task` for a plugin with a task list.

## [2026-11-16] ingest | One "How to work a task" text; wiki CI workflow

Source: user request.

- **Text:** the five generic steps are one page, `plugins/how-to-work-a-task.md`; every plugin `index.md` with a task list holds only a link under `## How to work a task` (checked by `wiki-check.ts`). Plugin-specific steps of jev-api, jevfort and universal-lint moved to `## Task conventions` in their `index.md`.
- **CI:** `.github/workflows/wiki.yml` runs the wiki check on PRs that change `development/wiki/**` or the check script (pr.yml ignores `development/**`).

## [2026-11-16] lint | Skills that use the wiki follow the new layout

Checked every skill that reads or writes the wiki. Updated: `perf-worklist` (open tasks = section Remaining, TASKS.md entry format, evaluation sections and name, plugin `index.md` Pages, how-to-work-a-task, wiki-check in jobs and analysis), `live-verify` (evaluation path and sections), `bughunt` (where plugin-specific findings go, docs audit scope), `wiki` (plugin index updates, extended lint description), `scaffold-plugin` (section and template, earlier). No change needed: `convert-plugin-ts`, `split-hooks-lib`, `refactor-plugin`.

## [2026-11-17] ingest | rc-enhancement migrated into this repository

Source: user request (migration PR).

- **Section:** `plugins/rc-enhancement/` (index, design page `design/interaction-gate.md`: mechanism, loop guard, origin and the live check of the former plugin), linked from `plugins/index.md`.
- **Plugin:** `rc-enhancement/` 0.3.0 (sources in `src/hooks/`, tests through the built entries); the `SessionStart` rule text is a constant in `session-start.ts` because `plugin/` may hold no markdown beyond the README.

## [2026-11-17] ingest | rc-enhancement 0.4.0: Stop command hook replaces the mods gate

Source: user request (refactor), live probes on Claude Code 2.1.326.

- **Facts:** `classic.SessionStart` and `classic.UserPromptSubmit` are bypassed by `cc-plugin-sec-default` (bypass lists in `mods-engine-lifecycle.md` and `claude-code-hook-facts.md`); only a `prompt.submit` rewrite reaches a model from a mod. A `Stop` command hook is not touched by it: payload keys, block continues the turn in place, `stop_hook_active` on the next stop (`plugins/rc-enhancement/design/interaction-gate.md`).
- **Decision (user, 2026-11-17):** the gate becomes a `Stop` command hook, main session only; the SessionStart rule stays and answers JSON.
- **Plugin:** `rc-enhancement/` 0.4.0: two command hooks, no mods module.

## [2026-11-17] ingest | Rule for the package.json description

Source: user decision (rc-enhancement 0.4.0).

- **Rule:** `.claude/rules/plugin-description.md` (loads with `*/package.json`): the description is one short end-user sentence on what the plugin gives, without implementation, configuration or requirements; applies to every plugin from its next change, no mass rewrite.

## [2026-11-17] ingest | $.mcp respawn, failed-start cache, env after launch (jev-api 0.6.0)

Source: live probe plugin on Claude Code 2.1.326 (throwaway, scratchpad), user decision to drop the `config` tool.

- **Facts:** `development/wiki/facts/mods-engine-io.md` (`## $.mcp`): a killed stdio server is respawned by the next `$.mcp.call`; a server exiting at start is cached as failed for 15 min across sessions; a settings `env` written mid-session reaches neither `$.env.get` nor a respawned server.
- **Decision:** `development/wiki/plugins/jev-api/tasks/F22-http-through-mcp-server.md` (Constraints, superseded 2026-11-17).

## [2026-11-17] ingest | dprint MCP tools audit: hook-only and hidden

Source: audit of the server and `hooks.json`, live check on Claude Code 2.1.326 (user request).

- **Page:** `development/wiki/plugins/dprint/notes/hook-only-tools-audit.md`: all nine tools are used by hooks only and carry `ui.visibility: ["app"]`; hooks still call them, the model finds and calls none. No code change.

## [2026-11-17] ingest | universal-format 0.19.0: migrated into this repository

Source: migration PR (user decisions of 2026-11-17), the 27 KB `src/universal-format-mcp/CLAUDE.md` and the plugin `CLAUDE.md` of kwitsch/claude-plugins, live probes on Claude Code 2.1.326.

- **Decision:** `development/wiki/decisions/repo-tooling.md`, "Vendored third-party bundles": `plugin/**/vendor/*.mjs` and `pluginBuild.assets`, rolldown, what was rejected. Constraint in `.claude/rules/plugin-build-output.md` and the root `CLAUDE.md`.
- **Section:** `plugins/universal-format/` (index, eight design pages, `notes/migration.md` with the test counts and the live check), linked from `plugins/index.md`. The constraints are in `universal-format/CLAUDE.md` and `universal-format/.claude/rules/` (`hooks-and-server.md`, `vendor-build.md`, `skill-driver.md`, `tests.md`).
- **Facts (live 2.1.326):** the hook payload `cwd` and the `${cwd}` placeholder of an `mcp_tool` hook are the worktree after `EnterWorktree`, without a `CwdChanged` event (`design/scope-and-base.md`); an `mcp_tool` `input` template substitutes text, an absent field becomes `""` and a boolean its string form (`design/hook-design.md`).
- **Measured:** start and format times of the code-split bundle against the former single file (`design/vendor-build.md`).

## [2026-11-18] ingest | jevfort 0.13.0: per-step effort (`stepEffort`)

Source: the `stepEffort` change (user decisions: no call without Jev, delta since the last effort answer, session-effort fallback).

- **Page:** `development/wiki/plugins/jevfort/design/step-effort.md`: why only Opus/Sonnet, the fallback order, why the question is asked only right before a model call and the delta runs from Jev's last answer, latency, rejected alternatives. Constraint in `jevfort/.claude/rules/effort-routing.md`, pointers in `jevfort/CLAUDE.md` and `jevfort/.claude/rules/register-hooks.md`.

## [2026-11-18] ingest | jevfort 0.13.1: step question calibration

Source: live smoke of 0.13.0 and fixed-delta scoring through jev-api.

- **Page:** `development/wiki/plugins/jevfort/design/step-effort.md`, section "Calibration of the question (0.13.1)": hard deltas scored under the low cut with the 0.13.0 text, above it with the new text.

## [2026-11-18] ingest | jevfort 0.13.1: step cuts and Jev outage

Source: `scripts/step-calibrate.mts` run (32 deltas x 5) and a user decision.

- **Page:** `development/wiki/plugins/jevfort/design/step-effort.md`: "Step cuts (0.13.1)" (calibration table, limits) and the fallback order (a failed Jev request turns the step scoring off for the turn, session effort).

## [2026-11-18] ingest | jev-solver removed

Source: user request.

- **Removed:** the `jev-solver` plugin (`jev-solver/`, its wiki section, the lockfile entry, the index line); the F21 task no longer names it as a sender. Historic mentions in `EVALUATION-2026-11-14-f01.md` stay. The synced copy in kwitsch/claude-plugins is removed in its own PR.

## [2026-11-18] ingest | jev-api 0.7.0 request only, jevfort 0.14.0 without estimate_effort

Source: user request.

- **Changed:** jev-api registers one tool, `mcp__jev-api__request` (the former `batch`, error prefix `request:`); the single-question tools `noul`, `choice` and `score` are removed (they stay question types). jevfort 0.14.0 registers no tool (`estimate_effort` removed) and asks Jev through `request`; its effort rule is tested through step 0 (`effortOf` in `jevfort/tests/support/kit.ts`). Current-facing pages (`plugins/index.md`, both plugin indexes, open tasks, `design/step-effort.md`, `notes/haiku-calibration.md`) name `request`; historic mentions of `batch` and `estimate_effort` stay.
- **Outside this repository:** taskflow 2.1.1 (kwitsch/claude-plugins `plugins/taskflow`: `agents/ci-monitor.md`, `skills/build-task/SKILL.md`, `workflows/build-task-plan.workflow.js`, `workflows/build-task-ship.workflow.js`, `test/taskflow/test.bats`) still names the removed `mcp__jev-api__choice` and `mcp__jev-api__score`: its Jev hints switch off silently until it asks `request` (a probe `ToolSearch select:mcp__jev-api__score` finds no tool, so its `JEV_AVAILABLE` is false). Found in the review of this branch, not fixed here; release a taskflow update with or before jev-api 0.7.0.
- **Tests:** jev-api 425 -> 405 tests and jevfort 387 -> 380 on the branch (the per-tool loops collapse, the live smoke block 4 -> 1, the `estimate_effort` tool tests are gone). Mutation probes on the built `plugin/` (delete one guard, run the tests, compare with `git show main:<plugin>/plugin/hooks/lib.mjs`) found guards that the rewrite left without a test: in jev-api the stale-attempt guard of `registerOne` and the `st.pending` check of `ensureTools`; in jevfort the `readBetweenTurns` marker of a subagent's out-of-turn env read, askJev's refused-clock `catch`, `jevMissing`'s later listing change and its `jevState` guard, the answer check behind the effort-fixture A1 and `missingJevTools` in the negative step rows. The review added a test for each (and one for the edge of the new clock-step guard) and made `calls()` of the jevfort kit count requests at an unlisted tool: jev-api 409 tests (408 run, the live smoke skipped), jevfort 382.

## [2026-11-19] ingest | cc-knowledge 2.2.0: migrated into this repository

Source: migration task (decisions listed in the PR body), the plugin `CLAUDE.md` files and bats suite of kwitsch/claude-plugins, a live check on Claude Code 2.1.328.

- **Section:** `plugins/cc-knowledge/` (index, four design pages, `notes/migration.md` with the test counts, the dropped cases and the live check), linked from `plugins/index.md`. The constraints are in `cc-knowledge/CLAUDE.md` and `cc-knowledge/.claude/rules/` (`references.md`, `skills-and-agents.md`, `lsp-audit.md`, `repository-audit.md`, `hook.md`, `tests.md`).
- **Skills:** `update-cc-references`, `dispatch-cc-references-update` and the agent `cc-reference-validator` are project-level here now (`design/maintenance-tooling.md`); listed in the index under Skills.
- **Fact:** the claude-engine-vitest kit did not match an array leaf in a matcher (`{ tool: ["Agent", "Task"] }`), so a hook with such a matcher never ran in a test; the kit now treats it as any-of (`facts/test-kit-vs-engine.md`).
- **Live (2.1.328):** an Agent call for `claude-code-guide` ran as `cc-knowledge:claude-code-expert` (`design/reroute-hook.md`).

## [2026-11-19] ingest | scratchpad paths: relative scratchpad_dir

- **Decision:** a relative `scratchpad_dir` means "no scratchpad" in all three plugins (dprint and universal-lint now guard with `path.isAbsolute` like universal-format); the lexical test stays, a symlinked spelling is not matched (`plugins/universal-format/design/scope-and-base.md`).

## [2026-11-19] ingest | shared source layer for plugins

- **Decision:** duplicates across plugins analysed; build-time shared source (`development/shared/` compiled into `plugin/shared/`) chosen by the user, plan only, nothing implemented (`decisions/shared-source-layer.md`).
- **Step 1 built:** `@shared/<name>.js` imports are compiled to `plugin/shared/` by `build-plugin.ts`, with no `pluginBuild.shared` list (imports decide); tests in the new `build-scripts` package; all existing plugins rebuild unchanged.
- **Step 2 built:** `development/shared/src/scope.ts` (path exclusions, `realish`, `outside`, `walkToRoot`) replaces the copies in dprint 0.14.2 and universal-format 0.19.2; tests in the new `shared-code` package; the build guard for `bundleHooksLib` plugins now covers `hooks/` only (dprint imports from `mcp/`). universal-lint left for later.
- **Scripts to `.ts`:** the five plugin dev scripts (`dprint/scripts/hooks`, `jevfort/scripts/step-calibrate`, `universal-format/scripts/vendor` and `vendor-entry`, `universal-lint/scripts/perf`) are `.ts` now and every reference follows; `vitest.config.mts` stays (renaming it edits the `test` script in every plugin's `package.json`, i.e. a bump for all). Left on purpose: the comment in `jevfort/src/hooks/policy.ts` still says `step-calibrate.mts` (a comment-only change of `src/` would force a jevfort release; fix it with the next source change). `graphmind-helper` and `inline-headroom` still hold `.mts` sources and tests until their first change (rule `src-typescript.md`).
- **Step 3 built:** `development/shared/src/mcp-core.ts` (`serveMcp`, `readManifestVersion`, `ToolDef`) is the dual-era loop of dprint's and universal-format's MCP servers; jev-api not moved; the loop has its own fixture-server tests, mutation check on scratch copies 25/25 killed (four survivors of the first run got tests).
- **Step 5 built:** the manifest tests of dprint, jevfort, universal-lint, universal-format and jev-api are one central test in `development/scripts/tests/plugin-manifest.test.ts` (all plugins, no pinned values).
- **Step 4 dropped:** nothing left to share as types after step 3 (`RequestId`, `ToolDef` live in `mcp-core.ts`); the three `HookResult` types differ on purpose (`decisions/shared-source-layer.md`).
