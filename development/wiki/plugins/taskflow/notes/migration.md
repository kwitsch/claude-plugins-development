# Migration into this repository (2.2.1)

What changed when taskflow moved from kwitsch/claude-plugins (`plugins/taskflow`, `test/taskflow/test.bats`) into this repository, how the merge script was ported and how the tests were carried over.

## Base

- Source: kwitsch/claude-plugins `main` at `140438450b8918456ae39a77b0abc3e5fa6e4d76`, plugin version 2.2.0 (local checkout level with `git ls-remote` on 2026-11-24).
- Version 2.2.1: `taskflow-2.2.0` is tagged in kwitsch/claude-plugins and the PR workflow refuses an existing tag, so 2.2.1 is the smallest untagged version; behaviour is unchanged (precedent: cc-knowledge's first release here).
- Decisions of the task (user, 2026-11-24): `package.json` is the manifest source with `claudePlugin: {}`; the description stays verbatim; agents, skills, workflow scripts and README are copied byte for byte into `assets/`; the only content change to shipped files is the merge script's name in seven lines of five files (`build-task-ship.workflow.js` 27 and 257, `agents/shipper.md` 16, `skills/build-task/SKILL.md` 71, `skills/build-task/workflows/ship.md` 48 and 87, `README.md` 85); the preset is pinned exactly to 0.3.0.

## The merge script: bash to Node

- `bin/ship-ensure-mergeable.sh` became `src/bin/ship-ensure-mergeable.ts`, built to `plugin/bin/ship-ensure-mergeable.mjs` (shebang `#!/usr/bin/env node`, mode 0755), because the preset refuses a plugin without a TypeScript entry and the layout allowlist rejects `bin/*.sh`. The shipper still runs the absolute path the ship workflow builds from `PLUGIN_ROOT`.
- Same contract: 4 non-empty arguments, `SHIP_MERGE_POLL_RETRIES` (default 3) and `SHIP_MERGE_POLL_INTERVAL` (default 5 s, fractions allowed), exit codes 0/1/64, stderr texts verbatim, one stdout line `mergeState=<clean|unknown|rebased|resolved>`. The usage line names `ship-ensure-mergeable.mjs`; no caller parses it.
- Deliberate quirk kept: jq's `//` semantics. Unparsable JSON with exit status 0 gives empty fields (jq printed nothing), which classify as `clean` on both platforms; a test pins it. Changing it is a separate behaviour change.
- No `jq` and no `sleep` binary any more: JSON is parsed in-process and the poll interval sleeps with `Atomics.wait`.

## Layout

- The preset's `validateLayout` (core 0.3.0) has no allowlist and accepts the workflow scripts and agents; the stop rule of the task did not trigger.
- This repository's CI check (`development/scripts/check-plugin-layout.ts`) accepts `agents/*.md`, `skills/*/SKILL.md` and `README.md` but not the 8 `workflows/*.workflow.js` and 7 `skills/build-task/workflows/*.md`; all 15 are listed in `pluginBuild.assets` with unchanged names ([workflows.md](../design/workflows.md)).

## Tests: 137 before, 138 after

- Before: 137 bats cases in `test/taskflow/test.bats` (127 structural, 10 for the merge script).
- After: 138 vitest cases: `plugin-shape.test.ts` 127 (shipped files read from the built `plugin/`, developer notes from `taskflow/CLAUDE.md` and `taskflow/.claude/rules/`), `ship-ensure-mergeable.test.ts` 11 (process tests of the built `.mjs` on an isolated PATH).
- Carried over: 133. Paths follow the move (shipped files under `plugin/`; the asserted strings of the old `CLAUDE.md` in `taskflow/CLAUDE.md`, of `workflows/CLAUDE.md` in the rule `workflows.md`, of `skills/dispatch-task/CLAUDE.md` in the rule `dispatch-task.md`); `.sh` became `.mjs` in five asserts; "version is 2.2.0" became "package.json and plugin.json agree on 2.2.1"; "`.sh` exists and is executable" became "the built `.mjs` is executable with the node shebang"; the "plugin, root README, marketplace, repo memory files" sweeps now cover `plugin/`, `taskflow/CLAUDE.md` and `taskflow/.claude/rules/`.
- New (5): `plugin.json` generated from `package.json` without `userConfig`; the layout check exits 0; no `CLAUDE.md` in `plugin/`; unparsable JSON from `gh pr view` gives `mergeState=clean`; a GitLab `merge_error` exits 1 with its message.
- Dropped (4): "marketplace description matches plugin.json", "marketplace entry exists" and "marketplace entry has no version" (`.claude-plugin/marketplace.json` lives in kwitsch/claude-plugins); "marketplace and root README mention changes-audit" (both files live there, and this repository's root README has no plugin table).
