# decide: why taskflow routes every decision through one skill

Why build-task and review-task ask through the `decide` skill, how `--headless` picks the advisor or the `decider` agent, and what a headless run does when no decision comes back.

## Decision (2026-11-28, user-approved spec)

- `decide` ([SKILL.md](../../../../../taskflow/assets/skills/decide/SKILL.md)) is SKILL.md only and runs inline in the caller: the advisor must see the content in the conversation, and the caller must read the output. Input: `[--headless] <JSON {content[], questions[1-4]}>`; output: the content as a bullet list, in headless one `Decided <id>: <answer> (<BY>: <reason>)` line per question, and a final `DECISIONS: [{id, answer}]` line. That is the shape of build-task's `USER_INPUT`, so build-task passes it to the design script unchanged.
- 1 to 4 questions per call, so build-task's design step keeps one batched question round.
- Rejected: (B) the decision logic inline in build-task and review-task: two copies, and the task asked for a skill; (C) a `HEADLESS` arg for the workflow scripts with an `agent()` decider inside the design script: a script agent cannot call the advisor, two of build-task's three decision points and all of review-task are outside scripts, and the design script's args and models are pinned by tests; (D) an ad-hoc `Agent` call with `model: "opus"`: the Agent tool takes no effort, so `effort: high` needs agent frontmatter.

## Headless: advisor first, then the decider agent

- The advisor decides when a tool named `advisor` is in the session's tool list: a direct tool without parameters that reads the whole conversation (docs). It sees the content bullets, so it decides with the caller's context; a false negative only costs a decider call.
- Advice that fails or leaves a question without a clear pick goes to `taskflow:decider`, for exactly those questions.
- `decider` is a plugin agent (`model: opus`, `effort: high`, tools Read/Grep/Glob, read-only by instruction) because the effort of a subagent started from a skill is set only in agent frontmatter (docs). Its answers count only for asked ids; a missing id fails the call. It follows the precedent "a read-only decision agent (opus, high) when the user is unavailable" (`.claude/rules/plugin-docs-tasks.md`).
- Headless never falls back to `AskUserQuestion`: it would stall an unattended run, and `claude -p` disables it ([claude-code-skill-facts](../../../../../.claude/rules/claude-code-skill-facts.md)). A failed headless decision prints `decide: no headless decision: <reason>`; build-task stops, review-task notes it and continues without the change.

## build-task stops instead of looping

- A bare "No — needs changes" at the headless intent check stops the run with the draft path: no user is there to describe the change, and a correction made up by the decider would be a guess.
- At most 3 design-script resumes per headless invocation (question answers and intent corrections together); a 4th stops with the draft path, so a design that does not converge cannot loop unattended.
- Headless answers enter the draft as binding USER DECISIONs; the final report lists every `Decided ...` line so a human can audit them.

## Not verified

- Advisor detection through the tool list, and that the pick can be read from the advice (docs). Manual check: one `--headless` decide call in a session with the advisor and one without, plus `/taskflow:review-task --headless` on a scratch branch.
- That `effort: high` in plugin agent frontmatter is honoured at run time (docs); `claude plugin validate --strict` accepted the key in the build.
- Out of scope: dispatch-task does not pass `--headless` (its rule keeps the payload free of autonomy nudging).
