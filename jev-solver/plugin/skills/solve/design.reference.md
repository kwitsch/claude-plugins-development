# design

Size L and XL of the feature track. No spec, plan or code before the design is approved. Output: `design.md` in the scratchpad (`jev-solver/<task-slug>/design.md`, never in the repo).

1. **Explore.** Read what the task touches: in a graphmind project start with `/gm` (`/gm-fn`, `/gm-deps`, `/gm-impact`), otherwise normal tools. Check recent commits and project conventions.
2. **Clarify.** One question at a time through `AskUserQuestion`, only what the code and sensible defaults cannot answer: for each candidate question ask jev-api (`noul`, [decide](decide.reference.md)) whether they already answer it, and ask the user only on a confident no. Prefer options over free text.
3. **Approaches.** For a real fork, name two or three approaches with trade-offs and pick one with a recommendation. Where the options are defined, use [decide](decide.reference.md) (`choice`) for the direction; difficulty or risk of an option goes through `score`. Keep the user's explicit choices.
4. **Write `design.md`:** goal, scope and non-goals, the approaches with the decision and why, affected components, risks. A page or two for L; the details (interfaces, error handling, tests) wait for the spec on XL and go into the plan on L.
5. **Check.** Re-read it once: no placeholders (TODO, TBD), no contradictions, nothing the task does not need, no ambiguity.
6. **Confirmation.** Print the design's full absolute path and a bullet-point summary (goal, scope, approach, affected components, risks; skipped with `--headless`), then ask for confirmation through `AskUserQuestion` (approve, change, abort). Fix and re-ask until approved. Then continue with [spec](spec.reference.md) on XL, with [plan](plan.reference.md) on L.

Size XL: also ask [request-review](request-review.reference.md) to review the design before the spec.
