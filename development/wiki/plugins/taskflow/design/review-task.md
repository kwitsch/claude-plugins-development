# review-task: why taskflow reviews with the bundled simplify and code-review skills

Why taskflow 3.0.0 replaced its own review engine with the `review-task` skill, how the size maps to the `code-review` level, what was given up, and why build-task writes the review result file itself.

## Decision (2026-11-27, user-approved spec)

- `review-task` ([SKILL.md](../../../../../taskflow/assets/skills/review-task/SKILL.md)) commits every pending change (`git add -A`), then runs Claude Code's bundled `/simplify` and `/code-review <level> --fix` over `<base>...HEAD`, one commit per pass. build-task step 5.3 calls it with its step-2.3 size; standalone users get the same behaviour.
- It replaces the `changes-audit` skill and build-task's review script. The in-plugin engine was deleted: the `changes-review` and `build-task-review` workflows (two ~600-line copies kept in step by hand), the `review.md` usage doc and the `review-finder`, `review-verifier` and `fix-applier` agents (13 → 10 agents). Removing the `/taskflow:changes-audit` command makes it a major version (3.0.0).
- SKILL.md only, no workflow script: workflow scripts cannot invoke skills, and the steps are a handful of git commands plus two skill calls. Argument formats `/simplify [target]` and `/code-review [low|medium|high|xhigh|max|ultra] [--fix] [pr#|branch|path]` (docs: cc-knowledge `claude-code-commands.reference.md`).
- Rejected: (B) wrap the existing engine and make the build-task script spec-optional: keeps spec-aware escalation and the lean pass, but is not the requested `simplify`/`code-review --fix` run and leaves ~650 lines of engine plus three agents; (C) engine plus both bundled skills: three passes per run, overlapping fixes, conflicting commits; (D) a `review-task.workflow.js`: adds a `pluginBuild.assets` entry, a usage doc, args decoding and tests for no gain.
- simplify runs before code-review, so code-review checks the simplified code.

## Size → level

- Mapping: `S` → `medium`, `M` → `high`, `L` → `xhigh`, `XL` → `max`. It lives once in the review-task SKILL.md, plus the matching test literal and the `taskflow/CLAUDE.md` bullet, so it is cheap to retune.
- One level per size, so the four sizes give four depths. `low` is skipped because even an S change gets a real review; `ultra` is excluded because it is a cloud review.
- XL reaches `max` although `.claude/skills/bughunt/SKILL.md` uses `/code-review high` and `.claude/skills/perf-worklist/SKILL.md` caps at `high` ("never `max`"): both run a review once per batch of many jobs, where the cost multiplies, while review-task reaches `max` only for a repository-wide change, where the extra depth is warranted.
- Without `--size`, review-task feeds `mcp__taskflow__size-task` the commit subjects and the diffstat, without `subsystems`. The tool is calibrated on task descriptions, not diffs ([size-calibration.md](size-calibration.md)); a mis-size shifts the level by one step (not measured).

## Accepted losses

- No spec-aware escalation: `code-review --fix` does not know the approved spec, so a fix may reverse a design decision without asking (the former `reversesDecision` filter and its user question are gone). Mitigation: every pass is its own commit, listed in the report and, through `REVIEW_PATH`, in the PR body, so it is visible and revertible.
- No separate ponytail lean (over-engineering) pass; `simplify` covers reuse and simplification.
- No interactive pick-list of findings (the former `AskUserQuestion` multi-select); `code-review --fix` applies its own findings.
- A branch target is reviewed by `code-review` against the repository's default branch, so a non-default base may widen its scope (docs, not run).
- `git add -A` commits every untracked, non-ignored file, as the task demands; the report lists the commits, so a stray file is visible.

## build-task writes `REVIEW_PATH` itself

- After review-task reports, build-task writes `review-<slug>.json` (`size`, `level`, `commits`, `summary`) with the Write tool. The ship script and its pr-author stay unchanged except one description string, and Ship's fail-closed `test -s` check on the review result file still guards a missing file.
- review-task refuses a detached HEAD and the base branch, so it never commits onto `main`; it never pushes, build-task's Ship pushes the review commits.
