# jev-solver

Skills-only plugin (no hooks, no src code): a rewrite of the superpowers workflow skills, minus SessionStart steering and subagent-driven-development. Depends on `jev-api` (`claudePlugin.dependencies`).

`plugin/skills/solve/SKILL.md`, `plugin/skills/solve/*.reference.md`, `plugin/agents/decider.md` and `plugin/README.md` are hand-written; `plugin/.claude-plugin/plugin.json` is build output of `package.json` (`pnpm build`).

- `solve` is the only skill; the phases are `solve/<name>.reference.md` files linked from its decision matrix (the `*.reference.md` suffix is what `development/scripts/check-plugin-layout.mts` allows). Triage = one `mcp__jev-api__batch` call (track choice + size score; `--size=` drops the score); the mapping lives in `solve/SKILL.md`.
- All user questions go through `AskUserQuestion`; with `--headless` the `agents/decider.md` agent (opus, xhigh) answers instead, briefed with options and document paths.
- `decide.reference.md` holds the shared rule for direction decisions via jev-api (confidence from the `confidence` option, fallback to own reasoning on error). Other references link to it instead of repeating it.
- Feature track by size: S direct, M plan, L design+plan, XL design+spec+plan, each document confirmed by the user (headless: decider) after a bullet-point summary.
- PR lifecycle lives in `solve/pr.reference.md`: draft PR after the first push, description rewritten on every push, merge-ready at the end (rebase on base, conflicts resolved, checks green, `gh pr ready`).
- Documents (design, spec, plan) go to the session scratchpad, never into the repo.
- `tests/skills.test.mts` pins solve as the only skill, one reference per name (add a reference = add its name to the list there and link it from solve), and the decider agent's model and effort.
