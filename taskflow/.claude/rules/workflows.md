---
paths:
  - "assets/workflows/**"
---

# Rule: taskflow workflow scripts

`*.workflow.js` files — `changes-review.workflow.js` and build-task's seven `build-task-*.workflow.js` scripts in `assets/workflows/` — are excluded from the root `.oxlintrc.json` (`ignorePatterns`, `**/*.workflow.js`): Workflow-tool scripts run inside an implicit async wrapper, so top-level `await`/`return` are valid there but not parseable as a standalone ES module. They ship byte for byte; each one is listed in `pluginBuild.assets` of `package.json`. Reasons for everything below: [workflows.md](../../../development/wiki/plugins/taskflow/design/workflows.md).

## Model assignment

- No model tier is pinned: every role floats on its family alias (`haiku`/`sonnet`/`opus`/`fable`). Do not reintroduce a pinned ID (`sonnet`/`haiku` were always bare); the tests sweep the whole plugin for one.
- `haiku` is the default tier: every fixed role in a script's `MODELS` and the per-task implementer/fixer. On `sonnet`: `MODELS.finder`, `verifier`, `applier`, `ponytailReviewer` in `build-task-review.workflow.js` and `changes-review.workflow.js`, `MODELS.ciFixer` in `build-task-ship.workflow.js`, the per-task reviewer for `complex` tasks (`reviewModel()` in `build-task-implement.workflow.js`), the design reviewer in `build-task-design.workflow.js`, the spec writer and spec reviewer in `build-task-spec.workflow.js`, `MODELS.planChecker` in `build-task-plan.workflow.js`. The `scout`, explorers, memory recall and `scribe` in `build-task-explore.workflow.js` run on `haiku`.
- The designer and planner pick their model per run from the `SIZE` arg, same table — `S → sonnet`, `M → opus`, `L → opus`, `XL → fable`, unset or unknown → `opus` — and same fallbacks: a `fable` dispatch that throws falls back to `opus` for the rest of the run, a `null` result on `fable` is retried on `opus`.
  - **designer** (`build-task-design.workflow.js`): `DESIGN_MODEL` / `designerModel()` resolve `DESIGNER_MODEL`, passed to the designer's `agent()` call.
  - **planner** (`build-task-plan.workflow.js`): `PLAN_MODEL` / `plannerModel()` resolve `PLANNER_MODEL`, used in all three planner dispatches.
- Fixed bare `opus`, not size-driven: `MODELS.synthesizer` in `build-task-review.workflow.js` and `changes-review.workflow.js`; `implModel()` in `build-task-implement.workflow.js` (`opus` for `complexity === "complex"` tasks, `haiku` otherwise; the per-task fixer reuses the implementer's model).
- The explicit `agent()` `model` option always wins over the agent frontmatter `model`: `DESIGNER_MODEL`, `PLANNER_MODEL`, or the script's `MODELS` entry (merger, pr-author, shipper and ci-monitor on `haiku`, ci-fixer on `sonnet`). The `MODELS` object at the top of each script is the single place to change a fixed assignment.
- The review depth follows the same size: build-task maps `SIZE` to `LEVEL` (`S`/`M` → `high`, `L`/`XL` → `max`) and passes it to `build-task-review.workflow.js`; no script derives it from the plan.

## `NO_NARRATION` on inline prompts

- Eleven roles are dispatched through a plugin `agentType` (`review-finder`, `review-verifier`, `fix-applier`, plus the eight build-task roles designer, design-reviewer, planner, worktree-merger, pr-author, shipper, ci-monitor, ci-fixer); their `assets/agents/*.md` system prompt carries the rule. Every other prompt in every script is inline and prefixed with `NO_NARRATION`: the scope-gathering, synthesizer and lean-pass agents of both review scripts, and the remaining agents of the other build-task scripts — scout, explorers, memory recall, scribe, spec writer, spec reviewer, plan checker, plan loader, per-task implementer/reviewer/fixer, result-file scribe, ship's result-files check. `build-task-design.workflow.js` has no inline prompt and no `NO_NARRATION` constant.
- Role agents are named only by `agentType`; no prompt of theirs points at a role file.
- Each script defines `const NO_NARRATION = "…"` (wording identical in every script and to the rule in `assets/agents/*.md`) near the top. Add the same prefix to any new inline (non-`agentType`) prompt in any workflow script.
- `agents/pr-author.md` deliberately lacks the English final-message sentence and its prompt in `build-task-ship.workflow.js` carries no `NO_NARRATION`: its outputs (PR/MR title and body) follow the repo's documentation language.
- The built-in `agentType: "Explore"` path (`explorerPrompt` in `build-task-explore.workflow.js`) carries the rule only in the per-call prompt text.

## Designer prompt (`build-task-design.workflow.js`)

- The designer prompt states that `keypoints` and `openQuestions` are separate structured-output fields — `openQuestions` must never be embedded as text/tags inside `keypoints`. `runDesigner`'s retry (`hasContaminatedKeypoints`) also retries a schema-valid result whose `keypoints` still contains `<openQuestions` or `</invoke`. `agents/designer.md` states the same rule.

## Lean (ponytail) review — report-only

- `build-task-review.workflow.js`'s Review phase and `changes-review.workflow.js` end with a separate, report-only lean pass (`PONYTAIL_REVIEW_SCHEMA` → `ponytailReview`) that reuses `SCOPE_BLOCK`/`DIFF_CMD` and reports over-engineering ONLY. `changes-review`'s copy drops the USER-APPROVED-spec paragraph.
- Its claims go through the same `verifyGroups` step as every other candidate; a claim at the location of a surviving combined finding is dropped. Never routed to fix application, never escalated.
- `agents/designer.md` and `agents/design-reviewer.md` embed ponytail's reuse ladder as static prose: no runtime `Skill`/`dependencies` reference to ponytail.

## Result files and the scribe

- `build-task-implement.workflow.js` and `build-task-review.workflow.js` each end by writing one JSON result file (`IMPLEMENT_PATH`, `REVIEW_PATH`) through an identical `persist()` helper (only its `phase` label differs): a `haiku` scribe writes with a Bash heredoc (`TASKFLOW_JSON_EOF`, never the Write or Edit tool), then reports `wc -c`; the script accepts only the expected UTF-8 byte count or one more (the heredoc's newline), with one retry.
- A failed write is an explicit `status: "error"` whose return still carries what the skill needs (Implement: `tasks`/`waves`/`results`/`minorFindings`; Review: `applied`/`escalatedToUser`).
- The explore scribe also writes with a Bash heredoc (`TASKFLOW_MD_EOF`) and accepts any reported size of at least `MIN_WRITE_RATIO` (0.9) of the expected UTF-8 byte count.

## Conditional graphmind path (build-task explorers, delivery planner)

- `build-task-explore.workflow.js` and `build-task-plan.workflow.js` derive a module-level `USE_GRAPHMIND` from the `GRAPHMIND_AVAILABLE` + `REPO_PATH` args; a set flag without an absolute `REPO_PATH` fails with a `stage: 'args'` error before any agent runs.
- Explore: when true, each subsystem runs the `NO_NARRATION`-prefixed inline `graphmindExplorePrompt` (no `agentType`; `gm_search`/`gm_outline`/`gm_deps`/`gm_fn` with `project` = `REPO_PATH`, Read/Grep/Glob fallback, `git log` via Bash); when false, the built-in `agentType: "Explore"` path via `explorerPrompt`. Both return the same `EXPLORE_SCHEMA` `{report}`. Memory is searched once by `graphmindRecallPrompt` after the explorers and appended as "Recorded project knowledge" (skipped on an empty or `none` result). The scout stays on `agentType: "Explore"`.
- Plan: a conditional paragraph in `plannerPrompt` only (the planner prompt is inline and carries `NO_NARRATION`). The design and spec scripts never use graphmind; the implement, review and ship scripts get only the tool hints.
- Availability detection lives once in `assets/skills/build-task/SKILL.md` (a `ToolSearch` `select:mcp__graphmind__gm_search` probe + `graphmind which` + `git rev-parse --show-toplevel`, threaded in via `args`); the scripts never self-probe. Review finders/verifiers do not use graphmind (Read/Grep/Glob/Bash only).
