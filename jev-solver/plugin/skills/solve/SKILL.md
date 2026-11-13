---
name: solve
description: Single entry point for any coding task (change, feature, refactor, bug). Triages the task through the jev-api tools and routes it to the right track, loading the phase references it needs. Flags --headless (the decider agent answers every question) and --size=<S|M|L|XL>. Use when the user hands over a task to implement or fix.
---

# solve

Entry point and the only skill of this plugin. The phases are reference files next to this one; open one (Read) only when its row in the decision matrix applies. Do not start work before the triage below.

## 0. Arguments

Strip these flags from the task text before anything else; the rest is the task.

- `--headless`: no question goes to the user. See [Questions and --headless](#questions-and---headless).
- `--size=<value>`: `S`, `M`, `L` or `XL` (case-insensitive). That value is the size; the size question of the triage is skipped. Any other value is not guessed: ask for the size through `AskUserQuestion` (options S, M, L, XL; headless: decider) after triage, and use the answer.

## Questions and --headless

Every question to the user goes through `AskUserQuestion`, never as plain text. This holds for this file and for every reference.

With `--headless`, `AskUserQuestion` is never called. Instead, for each question spawn the `decider` agent (`subagent_type: jev-solver:decider`, the plugin-namespaced name; continue the same agent with `SendMessage` while it still runs) and brief it with:

- the question and the options that `AskUserQuestion` would have shown (label and description, the recommended one first),
- the task text, track, size, branch and worktree path,
- the absolute paths of `spec.md`, `plan.md` and `review.md` as far as they exist, and what the answer is used for.

It replies `answer:` (an option label, or free text if none fits) and `reason:`. Apply the answer as if the user had chosen it and note the decision in one line in the spec or plan. Approval gates (spec, discard) are answered by it too; discarding a branch, merging and other destructive or outward-facing steps beyond the normal flow are not taken headless: keep the branch.

## 1. Triage

Ask jev-api once, with the user's task text as `state`:

```yaml
mcp__jev-api__batch
questions:
  - type: choice
    instructions: Which kind of task is this?
    criteria:
      tiny: a very small change (rename, typo, one-line or config tweak, one small edit)
      feature: new behaviour, a feature, a refactor or anything needing design decisions
      bugfix: something is broken, a failing test, an error, unexpected behaviour
  - type: score
    instructions: How large is the work?
    criteria: [S: a few lines in one place, M: one component, L: several components, XL: cross-cutting or architectural]
```

With `--size`, send only the choice question. The score is fractional: round to the nearest level. Apply the confidence rule of [decide](decide.reference.md) to the track; if it is low or the call fails (any error, no configuration), triage with your own reasoning using the same criteria and say so in one line.

When the track is `feature` or `bugfix` and the task text is ambiguous, ask via `AskUserQuestion` first (headless: decider).

## 2. Worktree and work branch

Always, for every track, right after triage and before any spec, plan, debugging or edit:

1. **Branch name.** Derive it from the task now: prefix `fix/` for the bugfix track, `feat/` for tiny and feature, then a short kebab-case slug of at most 40 characters (`fix/login-timeout`, `feat/retry-config`). Follow the repo's branch conventions if CLAUDE.md names any; the prefix stays.
2. **Enter a worktree.** Call `EnterWorktree` (load it via ToolSearch if deferred) with the slug as its name. Skip only when the session already is in a linked worktree (step 1 of [worktree](worktree.reference.md)); never nest.
3. **Switch to the work branch.** In the worktree, `git switch -c <branch>` (the harness names its own branch, for example `worktree-<name>`); in an already-linked worktree whose branch has no commits of its own, do the same. A branch that already has its own commits stays.
4. Report branch and worktree path in one line, then continue. The same slug names the scratchpad directory below.

Details and baseline: [worktree](worktree.reference.md).

## 3. Decision matrix

| Situation                                             | Reference                                     |
| ----------------------------------------------------- | --------------------------------------------- |
| Choosing between defined options, rating risk or size | [Decide](decide.reference.md)                 |
| Work starts, or starts outside a worktree             | [Worktree](worktree.reference.md)             |
| Feature or refactor, no approved spec yet             | [Design](design.reference.md)                 |
| Approved spec, multi-step work                        | [Plan](plan.reference.md)                     |
| A plan (or a tiny change) is to be carried out        | [Execute](execute.reference.md)               |
| Writing any production code                           | [Test first](tdd.reference.md)                |
| Bug, failing test, error, unexpected behaviour        | [Debug](debug.reference.md)                   |
| Before any claim of done, fixed or passing            | [Verify](verify.reference.md)                 |
| A change, phase or finished task needs review         | [Request review](request-review.reference.md) |
| Review feedback arrived (reviewer, user, PR)          | [Receive review](receive-review.reference.md) |
| Implementation and review done                        | [Finish](finish.reference.md)                 |

## 4. Tracks

Below, a name in brackets is the matrix row to follow.

### tiny

Implement directly. Then [Verify](verify.reference.md) and a light review: read your own diff once (`git diff`), nothing more. Then [Finish](finish.reference.md). No spec, no plan.

### feature

1. [Design](design.reference.md): writes the spec to the scratchpad; the user approves it.
2. [Plan](plan.reference.md): writes the plan to the scratchpad.
3. [Execute](execute.reference.md) (with [Test first](tdd.reference.md) for code).
4. [Verify](verify.reference.md).
5. `/simplify` once on the finished work (any size), then [Verify](verify.reference.md) again.
6. [Request review](request-review.reference.md), depth by size (L and XL: the per-phase and spec/plan reviews; the final diff is covered by the `/code-review` of the section below):

| Size | Review                                                          |
| ---- | --------------------------------------------------------------- |
| S    | read your own diff                                              |
| M    | one review of the final diff                                    |
| L    | a review after each plan phase, plus one of the final diff      |
| XL   | additionally a review of the spec and of the plan before coding |

Findings are handled with [Receive review](receive-review.reference.md). Then the final `/code-review` and [Finish](finish.reference.md).

### bugfix

On its `fix/` work branch (step 2): [Debug](debug.reference.md) (root cause, failing test, one fix), [Verify](verify.reference.md), [Request review](request-review.reference.md) (S, M: read your own diff; L and above: one review of the final diff; findings via [Receive review](receive-review.reference.md)), the final `/code-review`, [Finish](finish.reference.md). No spec or plan, unless the root cause shows the fix is really a feature: then switch to the feature track and say so.

### Final code review (feature and bugfix, never tiny)

After the track's own reviews and before [Finish](finish.reference.md), run `/code-review <level> --fix` on the branch, the level taken from the size: S `low`, M `medium`, L `high`, XL `xhigh`. Never `max` unless the user asks. Re-run [Verify](verify.reference.md) after it applied fixes.

### Done means pushed

The skill ends only when every change is committed and pushed on the work branch and a draft PR for it exists ([Finish](finish.reference.md) does this; no question about opening it). Report the PR URL.

## Documents

Spec, plan and review notes live in the session scratchpad directory (named in the system prompt) under `jev-solver/<task-slug>/` (`spec.md`, `plan.md`, `review.md`), never in the repository. Name them with their full absolute path when you mention them to the user (and to the decider).

## Code exploration

In a graphmind project (`graphmind which` exits 0) start every exploration with `/gm` (`/gm-fn` for reading a symbol, `/gm-impact` for blast radius); grep only for string literals and config. Otherwise use the normal tools. Save decisions and conventions found along the way with `graphmind memory add` (project scope).
