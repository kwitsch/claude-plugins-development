# Maintenance tooling of the reference files

How the reference files are refreshed from the official docs, and what changed when the tooling moved here.

## What it is

- `.claude/skills/update-cc-references/` (user-only): `refresh.ts` does the mechanical steps (`plan` fetches every mapped doc with `curl` as `<url>.md` with an HTML check and one `altUrls` retry; `gate` reverts hunks that add an `x.y.z` version found neither in the removed lines nor in the docs and labels line-changing hunks; `finish` keeps only the hunks the validator confirmed and stamps `verified`; `release` bumps the version). `sources.json` maps target to files to docs and carries per-file curated rules; `workflow.template.js` is the Workflow script `plan` fills in. Contract: `refresh.reference.md` next to it.
- `.claude/agents/cc-reference-validator.md`: read-only, local paths only, adversarial; answers CONFIRMED (with a verbatim quote), REJECTED or UNVERIFIABLE per hunk.
- `.claude/skills/dispatch-cc-references-update/`: starts one refresh in a worktree-isolated background session (`claude --worktree ... --bg`, model `haiku`, effort `high`, fixed). It is a fork of `dispatch-task` of `plugins/taskflow` in kwitsch/claude-plugins; the design is one fixed-model session whose transcript is the only result channel.
- The docs are never read through `WebFetch` (its summarizer fabricated content on these pages), only through `curl`.
- Fail-closed: an unverified line change never survives `finish`; a file edited after its `gate` run is stale and all its line changes revert.

## Changes in the migration

- Retargeted: `refsDir` is `cc-knowledge/assets/skills/cc-reference/references`, file names are the `*.reference.md` ones, the section index is `cc-knowledge/assets/skills/cc-reference/SKILL.md`. A target name is the file name without `.reference.md` (`claude-code-hooks`) (moved to `assets/` on 2026-11-24; the build copies them to `plugin/`).
- `refresh.mjs` became `refresh.ts`, run directly by Node 24 (erasable syntax, no new `.mts`).
- `release` bumps the patch in `cc-knowledge/package.json` (once per branch against `origin/main`; a version already ahead stays) and runs `pnpm --filter cc-knowledge build`, which regenerates `plugin.json`; the description date stamp is gone. Before the plugin is on `origin/main` the bump cannot read its base and exits 3.
- Commit and PR subject: `cc-knowledge <version>: refresh the CC reference files`, staging `cc-knowledge/package.json` and `cc-knowledge/plugin/`.
- Tests: `tests/update-cc-references.test.ts` (script, on a fixture repository with a curl and a pnpm stub) and `tests/maintenance-skills.test.ts` (shape).
