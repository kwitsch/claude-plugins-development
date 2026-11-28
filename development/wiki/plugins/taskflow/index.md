# taskflow knowledge

What the wiki holds for taskflow: pages for agent sessions (not shipped, English). The plugin's constraints are in its `CLAUDE.md` and `.claude/rules/`.

## Pages

- [CLAUDE.md](../../../../taskflow/CLAUDE.md): the plugin's overview and rule list (loads with the plugin's files).
- [design/workflows.md](design/workflows.md): design: why the workflow scripts, agents and result files are built the way they are (run by name, unpinned models, no narration, English artifacts, ponytail reuse ladder, scribe checks, scribe write path (Write only), graphmind path, shipped as `pluginBuild.assets`)
- [design/review-task.md](design/review-task.md): design: why `review-task` replaced taskflow's review engine with the bundled `simplify` and `code-review --fix`, the size → level table (why XL reaches `max`), the accepted losses and why build-task writes `REVIEW_PATH` itself
- [design/decide.md](design/decide.md): design: why build-task, review-task, spec-task and plan-task decide through the `decide` skill, the headless order (advisor, then the `decider` agent), why the decider is a plugin agent, no `AskUserQuestion` fallback in headless, the bare-"No" stop and the 3-resume cap, and what is not verified live
- [design/spec-and-plan-skills.md](design/spec-and-plan-skills.md): design: why build-task's spec and plan steps are the internal `spec-task` and `plan-task` skills, the resumable spec and plan scripts (`conflict`, `rounds_exhausted`), why every decision is re-sent on each resume, the output-path derivation, the headless cap of 3 and what is not verified live
- [design/design-task.md](design/design-task.md): design: why build-task's explore, size, design and intent steps are the internal `design-task` skill over one merged `build-task-design` script, `blocked` returns instead of errors, why re-explore re-runs the workflow while every other decision starts only the designer (USER DECISION), the headless cap of 3 re-runs, the rejected alternatives and what is not verified live
- [design/dispatch-task.md](design/dispatch-task.md): design: why `dispatch-task` is a fork, forces `--permission-mode auto`, uses a fixed heredoc delimiter and passes `--skip-branch-check` (do not "fix" without reading this)
- [design/size-calibration.md](design/size-calibration.md): design: why the size step asks a `choice` question and accepts at probability 0.5 (80-task calibration against System One and the Haiku fallback, the size-task tool and its Opus fallback, variants, rerun scripts)
- [notes/migration.md](notes/migration.md): the move from kwitsch/claude-plugins into this repository: base commit, version 2.2.1, the Node port of the merge script, the layout outcome, test counts and the dropped cases
