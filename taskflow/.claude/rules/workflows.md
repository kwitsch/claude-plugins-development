---
paths:
  - "assets/workflows/**"
---

# Rule: taskflow workflow scripts

`*.workflow.js` files — build-task's six `build-task-*.workflow.js` scripts in `assets/workflows/` — are excluded from the root `.oxlintrc.json` (`ignorePatterns`, `**/*.workflow.js`): Workflow-tool scripts run inside an implicit async wrapper, so top-level `await`/`return` are valid there but not parseable as a standalone ES module. They ship byte for byte; each one is listed in `pluginBuild.assets` of `package.json`. Reasons for everything below: [workflows.md](../../../development/wiki/plugins/taskflow/design/workflows.md).

## Model assignment

- No model tier is pinned: every role floats on its family alias (`haiku`/`sonnet`/`opus`/`fable`). Do not reintroduce a pinned ID (`sonnet`/`haiku` were always bare); the tests sweep the whole plugin for one.
- `haiku` is the default tier: every fixed role in a script's `MODELS` and the per-task implementer/fixer. On `sonnet`: `MODELS.ciFixer` in `build-task-ship.workflow.js`, the per-task reviewer for `complex` tasks (`reviewModel()` in `build-task-implement.workflow.js`), the design reviewer in `build-task-design.workflow.js`, the spec writer and spec reviewer in `build-task-spec.workflow.js`, `MODELS.planChecker` in `build-task-plan.workflow.js`. The `scout`, explorers, memory recall and `scribe` in `build-task-explore.workflow.js` run on `haiku`.
- The designer and planner pick their model per run from the `SIZE` arg, same table — `S → sonnet`, `M → opus`, `L → opus`, `XL → fable`, unset or unknown → `opus` — and same fallbacks: a `fable` dispatch that throws falls back to `opus` for the rest of the run, a `null` result on `fable` is retried on `opus`.
  - **designer** (`build-task-design.workflow.js`): `DESIGN_MODEL` / `designerModel()` resolve `DESIGNER_MODEL`, passed to the designer's `agent()` call.
  - **planner** (`build-task-plan.workflow.js`): `PLAN_MODEL` / `plannerModel()` resolve `PLANNER_MODEL`, used in all three planner dispatches.
- Fixed bare `opus`, not size-driven: `implModel()` in `build-task-implement.workflow.js` (`opus` for `complexity === "complex"` tasks, `haiku` otherwise; the per-task fixer reuses the implementer's model).
- The explicit `agent()` `model` option always wins over the agent frontmatter `model`: `DESIGNER_MODEL`, `PLANNER_MODEL`, or the script's `MODELS` entry (merger, pr-author, shipper and ci-monitor on `haiku`, ci-fixer on `sonnet`). The `MODELS` object at the top of each script is the single place to change a fixed assignment.
- The review depth follows the same size: build-task passes `--size=<SIZE>` to the `review-task` skill, which alone maps it to the `code-review` level; no script derives it.

## `NO_NARRATION` on inline prompts

- Ten roles are dispatched through a plugin `agentType` (the ten build-task roles designer, design-reviewer, planner, spec-writer, worktree-merger, pr-author, shipper, ci-monitor, ci-fixer, explore-scribe); their `assets/agents/*.md` system prompt carries the rule. Every other prompt in every script is inline and prefixed with `NO_NARRATION`: the remaining agents of the build-task scripts — scout, explorers, memory recall, spec reviewer, plan checker, plan loader, per-task implementer/reviewer/fixer, result-file scribe, ship's result-files check. `build-task-design.workflow.js` has no inline prompt and no `NO_NARRATION` constant.
- Role agents are named only by `agentType`; no prompt of theirs points at a role file.
- Each script defines `const NO_NARRATION = "…"` (wording identical in every script and to the rule in `assets/agents/*.md`) near the top. Add the same prefix to any new inline (non-`agentType`) prompt in any workflow script.
- `agents/pr-author.md` deliberately lacks the English final-message sentence and its prompt in `build-task-ship.workflow.js` carries no `NO_NARRATION`: its outputs (PR/MR title and body) follow the repo's documentation language.
- The built-in `agentType: "Explore"` path (`explorerPrompt` in `build-task-explore.workflow.js`) carries the rule only in the per-call prompt text.

## Designer prompt (`build-task-design.workflow.js`)

- The designer prompt states that `keypoints` and `openQuestions` are separate structured-output fields — `openQuestions` must never be embedded as text/tags inside `keypoints`. `runDesigner`'s retry (`hasContaminatedKeypoints`) also retries a schema-valid result whose `keypoints` still contains `<openQuestions` or `</invoke`. `agents/designer.md` states the same rule.

## Ponytail reuse ladder

- `agents/designer.md` and `agents/design-reviewer.md` embed ponytail's reuse ladder as static prose: no runtime `Skill`/`dependencies` reference to ponytail.

## Result files and the scribe

- `persist()` (implement) has a `haiku` scribe that writes with the Write tool to the absolute scratchpad path, then reports `wc -c`; the one retry is the same Write call (the isolation guard checks Bash command text, not Write); only the exact byte count or one more (a trailing newline) passes: [why](../../../development/wiki/plugins/taskflow/design/workflows.md).
- A failed write is an explicit `status: "error"` whose return still carries what the skill needs (Implement: `tasks`/`waves`/`results`/`minorFindings`).
- The explore scribe is `taskflow:explore-scribe` (`tools: Read, Write`): it Writes the script-built text, Reads it back and returns the lens names of its `## Lens: <name>` headers and `_End of lens: <name>_` footers; the script fails unless both lists equal the expected lenses in order. The one retry re-reads a written file and rewrites an unwritten one.
- `build-task-ship.workflow.js`'s pr-author writes `PR_BODY_PATH` with Write, its retry too. No Bash-based write path anywhere (no heredoc, no printf).
- The implementer, reviewer and fixer prompts in `build-task-implement.workflow.js` end with `BASH_SHAPE_HINT`.

## Conditional graphmind path (build-task explorers, delivery planner)

- `build-task-explore.workflow.js` and `build-task-plan.workflow.js` derive a module-level `USE_GRAPHMIND` from the `GRAPHMIND_AVAILABLE` + `REPO_PATH` args; a set flag without an absolute `REPO_PATH` fails with a `stage: 'args'` error before any agent runs.
- Explore: when true, each subsystem runs the `NO_NARRATION`-prefixed inline `graphmindExplorePrompt` (no `agentType`; `gm_search`/`gm_outline`/`gm_deps`/`gm_fn` with `project` = `REPO_PATH`, Read/Grep/Glob fallback, `git log` via Bash); when false, the built-in `agentType: "Explore"` path via `explorerPrompt`. Both return the same `EXPLORE_SCHEMA` `{report}`. Memory is searched once by `graphmindRecallPrompt` after the explorers and written as the lens `graphmind memory` (omitted when empty; a scout lens of that name is a `Scout` error). The scout stays on `agentType: "Explore"`.
- Plan: a conditional paragraph in `plannerPrompt` only (the planner prompt is inline and carries `NO_NARRATION`). The design and spec scripts never use graphmind; the implement and ship scripts get only the tool hints.
- Availability detection lives in `assets/skills/build-task/SKILL.md`, plus `assets/skills/plan-task/SKILL.md` for the plan script (a `ToolSearch` `select:mcp__graphmind__gm_search` probe + `graphmind which` + `git rev-parse --show-toplevel`, threaded in via `args`); the scripts never self-probe.

## Resumable spec and plan scripts

- `build-task-spec.workflow.js` and `build-task-plan.workflow.js` are resumable via `USER_INPUT` (non-empty = resume; the JSON string of every decision so far plus the triggering findings, binding for writer and reviewer) and return `user_input_required` (`reason` `conflict` | `rounds_exhausted`) instead of an error. Their review schemas (`SPEC_REVIEW`, `CHECK_VERDICT`) have the `conflict` severity with `options`. The `spec-task` and `plan-task` skills run them: [why](../../../development/wiki/plugins/taskflow/design/spec-and-plan-skills.md).
