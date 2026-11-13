# execute

Run the plan in this session, in order. No subagents.

1. **Branch.** `solve` already put you in a worktree on a `feat/` or `fix/` branch; confirm with `git branch --show-current`, and use [worktree](worktree.reference.md) if you started outside solve.
2. **Read the whole plan first.** For a step that looks unclear or wrong, ask jev-api first (`noul`, [decide](decide.reference.md)); on a confident yes stop and ask through `AskUserQuestion` before coding around it.
3. **Per step:** mark it in progress, follow it exactly (tests first, [tdd](tdd.reference.md)), run its check, mark it done. Commit per step or per phase, following the repo's commit conventions, and push after each commit as [pr](pr.reference.md) says (first commit: open the draft PR; every push: update its description).
4. **Stop and ask** when a dependency is missing, a check fails repeatedly, the plan has a gap (jev-api `noul` first), or you do not understand an instruction. Do not guess. A failing check is a [debug](debug.reference.md) case, not something to patch over.
5. **Phase end** (size L and above): [request-review](request-review.reference.md) on the phase's diff before the next phase.
6. **Done:** [verify](verify.reference.md), then the closing steps of the track in `solve` (`/simplify` on the feature track, reviews, final `/code-review`), then [finish](finish.reference.md).

Do not add anything the plan does not call for; note ideas for later instead.
