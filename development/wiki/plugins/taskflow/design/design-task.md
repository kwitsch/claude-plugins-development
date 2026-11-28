# design-task: why build-task's design phase is one skill over one script

Why build-task's explore, size, design and intent steps became the internal `design-task` skill over one merged workflow script, why every design failure is a decision, why non-explore decisions start only the designer, and what is not verified live.

## Decision (2026-11-28, user-approved spec)

- build-task step 2 calls `Skill(skill: "taskflow:design-task", args: "[--headless] <task text>")` ([SKILL.md](../../../../../taskflow/assets/skills/design-task/SKILL.md)); it ends with `RESULT: {"explorePath", "size", "designPath", "findings"}` or a `design-task:` stop line. Internal ("not for direct use") and model-invocable, like spec-task. taskflow 3.3.0.
- One script: `build-task-explore.workflow.js` was merged into `build-task-design.workflow.js`, phases Scout → Explore → Scribe → Size → Design ([usage reference](../../../../../taskflow/assets/skills/design-task/workflows/design.md)). The task makes the workflow the core and requires it to return the explore path and the size on every exit. The name `build-task-design` keeps the `build-task-<name>` naming of skill-owned scripts.
- Size runs inside the script: a haiku inline agent calls `mcp__taskflow__size-task` with the same inputs as build-task's former size step, sizes by its own reasoning when the tool is missing or errors, and the script uses `M` when the agent returns nothing twice. An explore failure does not skip Size, so every return carries a size.
- `blocked` instead of `error`: every failure after the args check returns `status: "blocked"` with a `reason` and 1-4 decide-ready `questions` (E1 exploration failed, D1 designer blocked, D2 reviewer returned nothing, D3 blocking findings after the revision round, D4 open design questions, the former `user_input_required`). Only malformed args stay `error`. Both files stay on disk and every stop line names them.
- Routing (USER DECISION): `Stop` stops; `Re-run explore`, or any answer to the `explore` question, re-runs the whole workflow with the exploration focus and every earlier decision in `TASK` (a full run overwrites the draft); every other answer, and every intent correction, starts only `taskflow:designer` through the Agent tool, without the design reviewer and without re-running the Design stage. The script's `RESUME`, `SIZE` and `USER_INPUT` args were removed, because nothing calls a design-only run any more.
- The direct designer dispatch follows decide's `decider` precedent (`Agent` with `subagent_type`): the script's `designerPrompt` wording in its resume form, the size → model table with one `opus` retry after a `fable` dispatch error, and a JSON final message (`status`, `detail`, `keypoints`, `openQuestions`) that the skill parses and checks for contamination (`<openQuestions`, `</invoke`), with one retry.
- Every dispatch carries all decisions so far, so nothing is lost when the draft does not exist yet (designer blocked on the first run). Control answers (`Retry the design`, `Run another design round`) are not decisions; the text of the question they answered (block reason or blocking findings) goes in as revision input.
- Headless cap: 3 re-runs per invocation, full re-runs and designer dispatches together, the value of the former cap of 3 design resumes ([decide.md](decide.md)).
- The intent acceptance moved from build-task into design-task; build-task was renumbered (Spec 3, Deliver 4, Report 5) and keeps its own graphmind and jev-api probes for Deliver.

## Rejected

- (A) Two scripts, with the size step in the skill between them: the smallest diff, but the task makes the workflow the core, "based on the Explore workflow, extended by Size and Design stages", and requires the workflow itself to return the explore path and the size.
- (B) A new `design-task.workflow.js` beside both old scripts: three scripts with duplicated explore and design code, two of them dead, and it breaks the `build-task-<name>` naming the tests and `CLAUDE.md` use.
- (C) Merging into `build-task-explore`: that name would misdescribe a script whose main output is the design draft.
- (D) A design-only re-run through the script (`RESUME: true`: designer and reviewer, explore and size skipped): keeps the review gate, the schema and the in-script fable fallback, but rejected by USER DECISION in favour of the designer-only dispatch.

## Accepted losses

- No design review on the designer-only path: after a decision or an intent correction the user's acceptance is the only gate; `findings` in `RESULT:` reflect the last workflow review only.
- No schema on the direct dispatch: the `keypoints`/`openQuestions` split rests on the prompt's JSON instruction plus the skill's check and one retry.
- Design errors that used to stop a run now ask a decision; in headless mode the advisor or the decider answers, and each re-run counts against the cap.

## Not verified

- That a workflow subagent reaches the plugin-registered `mcp__taskflow__size-task` (docs; precedent: the planner calls `mcp__jev-api__request` inside `build-task-plan.workflow.js`). If it does not, the printed `Size:` line shows `own reasoning`.
- That the Agent tool's `model` parameter accepts `fable` (docs); a dispatch error falls back to `opus` once.
- Manual check: one `/taskflow:build-task --headless` run, then confirm the `Size:` line, design-task's `RESULT:` line and its `Decided ...` lines in build-task's report.
