# Handing implementation to subagents and pipelines

What went wrong when a plan was implemented by delegated agents (spec-driven delivery pipelines, workflows, per-task worktrees), and how to phrase the hand-off so it does not happen again.

Observed with the delivery pipelines used in November 2026; the points hold for any setup where implementers work on task branches and a reviewer gates each task.

- **Name every file a task must be allowed to edit.** A version bump also needs the plugin's manifest test (`<name>/tests/manifest.test.ts` asserts the exact version in some plugins): a spec whose edit allow-list omitted it blocked the bump task (2026-11-08).
- **Do not write "add new commits on the work branch" as a global constraint.** Implementers commit on their task's worktree branch and the merge comes after the review; a reviewer that reads the constraint literally rejects every task. Say "tasks commit on their own branch and are merged per wave", or leave it out (2026-11-07).
- **A fixer may commit on the wrong branch.** A per-task fixer once committed on the work branch instead of its task branch; the re-review then found no fix on the reviewed branch and the stage stopped with four of five tasks merged. After such a stop, the work branch holds the merged tasks plus a stray commit: recover by hand or re-run only the remaining task (2026-11-11).
- **Check what a docs task deleted.** An implementer of a documentation task removed README sections the plan had kept. Diff the README against the plan before accepting.
- **Answers handed back to a resumed run can be damaged.** A resumed pipeline once received a user's answers as the literal string `[object Object]`; the readable record was the run's decisions file in the scratchpad. Read the decisions file, not the echoed answer.
- **Scratch files of agents trigger hooks too.** A lint finding on a file in a task worktree, or on a scratch test an agent wrote and deleted again, is not the orchestrating session's to fix. Since universal-lint 0.17.0 a subagent's findings go to that subagent at its stop.
- **Background reviewers edit while you read.** When a `--fix` review or a fix job is still running in the same worktree, do not build, test or commit; wait for its completion notice and verify the final state then.
