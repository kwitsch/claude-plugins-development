# spec-task and plan-task: why build-task's spec and plan steps are skills

Why build-task runs its spec step and its plan step through the internal `spec-task` and `plan-task` skills, why the spec and plan scripts became resumable, and what is not verified live.

## Decision (2026-11-28, user-approved spec)

- build-task step 4 calls `Skill(skill: "taskflow:spec-task", args: "--size=<SIZE> <DRAFT_PATH>")` and step 5.1 calls `Skill(skill: "taskflow:plan-task", args: "--size=<SIZE> <SPEC_PATH>")` ([spec-task](../../../../../taskflow/assets/skills/spec-task/SKILL.md), [plan-task](../../../../../taskflow/assets/skills/plan-task/SKILL.md)). Both take `[--headless] [--size=S|M|L|XL] <absolute input path>` and end with `RESULT: {json}` or a `spec-task:` / `plan-task:` stop line. They are internal ("not for direct use"), like `decide`. Direct use is not blocked, because build-task calls them through the Skill tool. taskflow 3.2.0.
- Approach A: thin skills over the existing scripts `build-task-spec` / `build-task-plan`, which stay the engine (agents, models, fable fallback, fail-closed rules unchanged; see [workflows.md](workflows.md)). The scripts gained a `conflict` review severity with reviewer-supplied `options`, an optional `USER_INPUT` arg (non-empty = resume), and a `user_input_required` exit with `reason` `conflict` or `rounds_exhausted`, mirroring the resumable design script.
- A conflict (requirements of the input that force mutually exclusive points into the output) skips the fix round and goes straight to `decide`. "Correction runs exceeded" means blocking findings are left after the script's one fix or revision round. The count per script run stays 1, and the user can grant more rounds through `decide` ("Run another correction round").
- At size `L`/`XL` the skill asks for the same intent acceptance as build-task's design check (`Yes — proceed` / `No — needs changes`). build-task's step-3 design check stays, so an L/XL run gets up to three human checkpoints. The task asked for this.
- Without `--size` the skill sizes its input with `mcp__taskflow__size-task`, passing the input's Keypoints and Goal sections and no subsystems. That differs from the task-text-plus-subsystems input the tool was calibrated on ([size-calibration.md](size-calibration.md)). Accepted: build-task always passes `--size`.

## Rejected

- (B) A skill-native loop without scripts: reviewer prompts, schemas, the fable fallback and the null-retry/fail-closed rules would move from deterministic JS into prose, and every agent result would land in the main context. It would also discard a tested engine.
- (C) Wrapping the unchanged scripts and calling `decide` on any `error`: the old schema had only `blocking|minor`, so a conflict could not be told apart from a normal finding. Findings arrived only as a stringified error. A re-run ignored the decision, and the reviewer would re-flag the decided deviation forever.
- (D) Keeping the loop inside build-task with no new skills: this contradicts the task.
- Renaming the moved usage refs to `*.reference.md`: it churns every link and test pin for no gain. They stay `workflows/spec.md` / `workflows/plan.md` inside the owning skill and are listed in `pluginBuild.assets`.

## Every decision is re-sent on every resume

- The scripts are stateless. A resume passes `USER_INPUT` = `{"decisions": [every {id, question, answer} so far], "findings": [the triggering findings]}` to both the writer/planner and the reviewer/checker. Without all earlier decisions the reviewer would flag a decided deviation again, and the writer could undo it. The fix or revision round of a resumed run carries the decisions as well.
- Each decision carries its question text: `findings` holds only the findings of the latest triggering return, so a later resume would otherwise show a bare answer such as "Stop" or "Resolve it with the smallest change to the input's intent" with nothing to say what it resolved. An accepted `rounds_exhausted` outcome is recorded as a decision too (answer plus the accepted findings), or an L/XL acceptance correction after it would make the reviewer raise them again.
- The writer and planner prompts of a resumed run say that a binding decision overrides the input and their own carry-over rules (`spec-writer`: carry over every draft decision, `USER DECISION` immutable; `planner`: never re-open design decisions, constraints verbatim). A resolved conflict deviates from the input by definition, and the reviewer and checker already treat decisions as overriding.
- The skills never Read a whole pipeline file: they Read the first 200 lines of the input (existence check, `Keypoints` and `Goal` for sizing and acceptance) and grep the plan's `### Task` headings. The plan holds full code for every task and the Read tool stops at 2000 lines, so a full Read would also cut the acceptance list short.
- `USER_INPUT` grows with every resume. Interactive runs are unbounded by design. Headless runs are capped (below).

## Output path

- The only parameter is the input path. The output goes in the same directory with a prefix swap (`draft-<slug>.md` → `spec-<slug>.md`, `spec-<slug>.md` → `plan-<slug>.md`), which keeps build-task's file names. An output path equal to the input path stops the skill.

## Headless cap of 3

- At most 3 script resumes per skill invocation, counting decide-triggered resumes and acceptance corrections together. This is the same value and wording as build-task's design cap ([decide.md](decide.md)), so an unattended run cannot loop.

## Not verified

- Three-level nesting of inline skills (build-task → spec-task/plan-task → decide through the Skill tool) has not been run live. review-task already calls decide from inside build-task (two levels). Manual check: one `/taskflow:build-task --headless` run at size L, then confirm that the spec-task and plan-task `Decided ...` lines and `RESULT:` lines reach build-task's report.
- A reviewer may label a plain gap as `conflict`. That costs one extra decide call and loses no data. Not measured.
