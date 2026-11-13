# jev-solver

Skills-only plugin (no hooks, no src code): a rewrite of the superpowers workflow skills, minus SessionStart steering and subagent-driven-development. Depends on `jev-api` (`claudePlugin.dependencies`).

`plugin/skills/*/SKILL.md` and `plugin/README.md` are hand-written; `plugin/.claude-plugin/plugin.json` is build output of `package.json` (`pnpm build`).

- `solve` is the only entry point; the other skills are phases it routes to. Triage = one `mcp__jev-api__batch` call (track choice + size score); the mapping lives in `solve/SKILL.md`.
- `decide` holds the shared rule for direction decisions via jev-api (confidence from the `confidence` option, fallback to own reasoning on error). Other skills point to it instead of repeating it.
- Documents (spec, plan) go to the session scratchpad, never into the repo.
- `tests/skills.test.mts` pins frontmatter (name equals directory) and the jev-api dependency; add a skill = add its name to the list there.
