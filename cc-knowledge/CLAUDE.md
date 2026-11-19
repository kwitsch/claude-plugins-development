# cc-knowledge

Answers questions about authoring and configuring Claude Code from bundled reference files, and reviews, creates, compresses and audits Claude Code components against them. One function-hooks module reroutes the built-in `claude-code-guide` agent to the plugin's expert.

## Parts

Two layers. The path-scoped rules in `.claude/rules/` load with matching files and hold the constraints only. The design pages in `development/wiki/plugins/cc-knowledge/design/` hold the reasons and what was rejected; they are not loaded by themselves.

- `plugin/skills/cc-reference/` (lookup skill, `references/*.reference.md`): rule `references.md`. Reason for the layout and the style: [reference-files.md](../development/wiki/plugins/cc-knowledge/design/reference-files.md).
- `plugin/skills/cc-review/`, `cc-author/`, `memory-audit/` (inline orchestrators, all grounded in `cc-reference`) and `plugin/agents/{claude-code-expert,cc-reviewer,cc-author-planner}.md` (read-only workers): rule `skills-and-agents.md`.
- `plugin/skills/cc-compress/` (script `src/skills/cc-compress/scripts/compress.ts`): rule `skills-and-agents.md`; adapted from `caveman-compress` (JuliusBrussee/caveman).
- `plugin/skills/lsp-audit/` (script `src/skills/lsp-audit/scripts/audit-lsp.ts`, catalog `lsp-map.json`): rule `lsp-audit.md`.
- `plugin/skills/repository-audit/` (script `src/skills/repository-audit/scripts/detect-tools.ts`, catalog `tool-map.json`, template `templates/init-dev-environment/`): rule `repository-audit.md`.
- The reroute hook (`src/hooks/register.ts`, `plugin/hooks/hooks.json`): rule `hook.md`.
- Tests: rule `tests.md`.
- Development tooling of this repository, not shipped: the project skills `update-cc-references` (refreshes the reference files from the official docs, script `.claude/skills/update-cc-references/refresh.ts`, `sources.json` maps files to docs) and `dispatch-cc-references-update` (starts a refresh in a background session), and the agent `.claude/agents/cc-reference-validator.md` that the refresh's contradiction gate dispatches. They are user-only, edit `cc-knowledge/plugin/skills/cc-reference/references/` in place, and their `release` step bumps the patch version in `package.json` and runs `pnpm --filter cc-knowledge build`; never edit `plugin.json` by hand. Reasons: [maintenance-tooling.md](../development/wiki/plugins/cc-knowledge/design/maintenance-tooling.md).

## Constraints

- Adding a component needs a deliberate design decision. The ten skills and three agents above are the set.
- `cc-author`, `memory-audit` and `cc-author-planner` extend the lookup-review pair into lookup-author-review, all sourced from `cc-reference`: no duplicated reference text. `claude-code-expert` answers only from `cc-reference` (never from training memory); live docs only through `cc-reference`'s `WebFetch` fallback.
- `memory-audit`, `lsp-audit` and `repository-audit` deliberately have no `cc-` prefix: do not "restore" one.
- Reference files and the other markdown the layout check allows in `plugin/` are named `*.reference.md` (`SKILL.md` aside): `claude-code-hooks.reference.md`, `analysis-workflow.reference.md`. Renaming one means updating the `cc-reference` section index, `sources.json`, the README, the agents and the tests.
- Versioning is the root rule: `version` only in `package.json`, no description date stamp, no manual tags.
- No `userConfig`: `claudePlugin` is `{}`.
- The skill and agent names of the shipped plugin are `cc-knowledge:<name>` (renamed from `claude-code-knowledge` in 2.0.0, Claude Code reserves third-party plugin names starting with `claude-`).
