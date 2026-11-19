# Migration into this repository (2.2.0)

What changed when cc-knowledge moved from kwitsch/claude-plugins (`plugins/cc-knowledge`, `test/cc-knowledge`, the project skills in `.claude/`) into this repository, how the tests were carried over, and the live check.

## Base

- Source: `origin/main` of kwitsch/claude-plugins at plugin version 2.1.2 (the local main was level with it). 2.2.0 is the first release from this repository; the tag existed in neither repository (checked 2026-11-19).
- Decisions of the task: `package.json` is the manifest source; the description is one short sentence without the `(CC docs read: ...)` suffix; hand-written code is `.ts` under `src/`; the layout allowlist is not edited, so reference files became `*.reference.md` ([reference-files.md](../design/reference-files.md)); `install.sh` and `SKILL.md.tmpl` ship as `pluginBuild.assets`; the project skills and the validator agent live in this repository's `.claude/` ([maintenance-tooling.md](../design/maintenance-tooling.md)).

## What changed in behaviour

- Nothing in the shipped scripts: `compress.ts`, `audit-lsp.ts` and `detect-tools.ts` are the originals with explicit types and TSDoc. Byte comparison of the built `.mjs` against the originals (same inputs, stdout, stderr, exit status and resulting file tree): `detect-tools` audit, `--write`, a missing root; `audit-lsp` audit, `--fix`, `--apply .py,.rs,.bad`; `compress` usage, a sensitive name, a non-markdown file, a missing file, a refused untracked file (7 runs, all identical).
- The reroute hook is one file (`src/hooks/register.ts`, the helper folded in), behaviour identical. A non-string `subagent_type` normalizes to `""` instead of `String(x)`; no non-string can spell the guide, so the outcome is the same.
- `lsp-audit/SKILL.md` pointed at `plugins/cc-knowledge/skills/cc-reference/references/...` (a path of the marketplace repository); it now says `${CLAUDE_SKILL_DIR}/../cc-reference/references/claude-code-plugins-lsp.reference.md`. The README's maintenance paragraph names this repository and `package.json`.
- `install.sh` keeps git mode 100644 as in the original (the generator copies its bytes and sets the modes itself).
- The claude-engine-vitest kit matches an array leaf in a matcher as any-of ([reroute-hook.md](../design/reroute-hook.md)).

## Tests: 283 before, 309 after

- Before: 259 bats cases in `test/cc-knowledge/test.bats`, 16 in `update-cc-references.bats`, 4 `node:test` cases (`reroute.test.mjs`) and 4 kit cases (`tests/cc-knowledge.test.ts`, local-only `claude plugin test`).
- After: 309 vitest cases in 8 files, all against the built `plugin/`: `plugin-shape` 120, `lsp-audit` 43, `detect-tools` 41, `maintenance-skills` 26, `compress` 25, `install-sh` 19, `hook` 18, `update-cc-references` 17. The 4 reference-file cases of the bats suite expand to one test per file (14 files now: the former 11, plus the lsp and marketplace references).
- Carried over one to one: the three script suites (`compress` 18 script cases, `audit-lsp` 26, `detect-tools` and `install.sh` all script cases), the skill and agent frontmatter cases, the project-skill and validator cases, the 15 `refresh` cases that survive.
- New (8, one of them in the kit's own suite): the description rule, the project skill's commit style and retargeted paths, the dispatcher's origin note, the `package.json` manifest marker, `release` leaving the description alone and failing when the build fails (3 in `update-cc-references`, replacing the date-suffix case).
- Dropped without a replacement:
  - `marketplace.json` entry and "no version in the entry" (2): the marketplace lives in the other repository.
  - Root README rows for memory-audit, cc-compress, lsp-audit, repository-audit and init-dev-environment (5): there is no root README row in this layout.
  - `CLAUDE.md lists X` for memory-audit, cc-compress, lsp-audit, repository-audit and init-dev-environment (5): `CLAUDE.md` is not in `plugin/`; the constraint pages are checked by `wiki-check.ts`.
  - "version was bumped" history cases (9, one per feature release up to 1.12): replaced by one case that `package.json`, `plugin.json` and the semver shape agree.
  - "description mentions X" (6): the description is one short sentence by rule; one case asserts the rule.
  - hook wiring: `mod source and wiring-test files exist`, `reroute.mjs` mode 100755 in the index, `register.ts` contains the `on("tool.call"...)` text, `claude plugin test` (4): the layout check and the kit tests show the same, the helper file is gone.
  - `harness` directory absent in the old-artifacts case (1): the directory is in the other repository.
- Merged: `exists, is executable` and `passes node --check` of `compress.mjs` (one bats case already), `plugin.json is valid JSON` with `name is cc-knowledge`, `declares a version` with the semver case, the two "old hook gone" and "old MCP server gone" cases (one case), the four `reroute.test.mjs` cases into table rows of `hook.test.ts` (spellings, other types).
- Changed on purpose: the `release` cases of the refresh script (no description date, the build runs and its failure exits 1).

## Live check (2026-11-19, Claude Code 2.1.328, headless, `--setting-sources project`, Haiku)

- Method: `claude -p --plugin-dir cc-knowledge/plugin` in a throwaway directory with a `package.json`.
- Hook: an Agent call for `claude-code-guide` ran as `cc-knowledge:claude-code-expert` (debug log: `source=agent:custom:cc-knowledge:claude-code-expert`, agent completion with that `agentType`). The expert could not read `cc-reference` because the run did not allow the Skill tool, so it answered that it was denied: no content check of the expert's answer.
- Script: `node .../detect-tools.mjs .` run by the session answered `node` for the directory.
- `claude plugin validate cc-knowledge/plugin` is part of the test suite (`hook.test.ts`) and lists `./register.mjs hooks: tool.call{tool=Agent|Task}`.
- Not exercised live: the skills as slash commands, the agents' answers from the references, `cc-compress` against the real `claude`, `lsp-audit` and `repository-audit` interactive flows (they stop at `AskUserQuestion` in `-p`), the project skills `update-cc-references` and `dispatch-cc-references-update` (network, background sessions), and `release` against a real `origin/main` (the plugin is not on it before this PR merges).
