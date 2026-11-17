# Interaction gate

How rc-enhancement's gate re-prompts a turn that ends in a plain-text question, and where the plugin came from.

## Behaviour

- Heuristic: strip fenced code blocks, take the last non-empty line, gate when it ends in `?`. Blunt on purpose: a rhetorical trailing `?` is an accepted false positive, traded for simplicity and for matching the rule's own "no exceptions" wording.
- Only `reason === "answer"` main-loop turns (`e.agentId === undefined`); subagent, aborted and errored turns are never gated.
- The questioning answer is not suppressed: the turn ends, its answer stays visible, and the correction arrives as a separate turn (in `claude -p` that second turn runs before the process exits).

## Mechanism

- A user-tier mod has no native `Stop` block (`classic.Stop` is bypassed by `cc-plugin-sec-default`, [claude-code-hook-facts.md](../../../../../.claude/rules/claude-code-hook-facts.md)). `turn.complete` therefore calls `$.prompt.submit({ text })` unawaited: the engine queues a framed plugin prompt ("The rc-enhancement plugin sent a message: …") that starts a new turn once the session is idle. Awaiting it would wait for that turn to start, which waits for this turn to end.
- The text names the `CRITICAL RULE` that `session-start.mjs` injected, so the model is pointed at the full rule instead of a one-line paraphrase.

## Loop guard

- Replaces the platform's `stop_hook_active` and 8-consecutive-block cap. `turn.start` records the main-loop turn whose prompt contains the gate text; `turn.complete` never gates that turn, so there is at most one re-prompt per user turn.
- Backstop for a framing change the text match would miss: a submit also marks the next main-loop turn as the gate's (`gatePending`), so the gate can never loop. A user prompt that happens to start first takes that exemption instead (at worst one missed gate). A rejected submit clears the flag.
- State sits inside `register()`; a hot reload forgets both values, which at worst lets one more re-prompt through.

## Origin

- 2026-11-17, decided by the user: the gate moved out of `coding-toolbox` (0.26.0, kwitsch/claude-plugins PR #298) into `rc-enhancement` 0.2.0, which was then migrated into this repository as 0.3.0 with the repository's layout and the sync to kwitsch/claude-plugins. The `SessionStart` rule hook stays and the gate points back at it. Rejected: leaving the gate in coding-toolbox (the rule and its enforcement belong together).
- Live check before the move (`claude -p --plugin-dir`, 2026-11-17, Claude Code 2.1.326): the rule text arrived as SessionStart context, a turn ending in `?` got exactly one gate prompt, and that second turn was not re-gated. `SessionStart.md` of the former plugin was a `cat`-ed file; `plugin/` here may hold no markdown beyond the README, so the text is a constant in `src/bin/session-start.ts`.

## Rule delivery

- 2026-11-17: moving the rule into the mod was tried and rolled back by the user. The `SessionStart` command hook stays (now `src/bin/session-start.ts`, answering `{ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } }` instead of plain stdout); the gate module is split into `register.mjs` plus a compressed `lib.mjs` (0.4.0).
- Live probes (`claude -p --plugin-dir`, Claude Code 2.1.326, throwaway mod): a mod has no channel for session context. `classic.SessionStart` and `classic.UserPromptSubmit` are bypassed by `cc-plugin-sec-default` (notice `its classic.<Event> hook was skipped`), so `additionalContext` of a wrapped hook never arrives. A `turn.start` rewrite and a `turn.step` rewrite (`system`, `systemPrompt`, `additionalContext`, `context`, `appendSystemPrompt` fields) do not reach the model. Only a `prompt.submit` rewrite (`next({ ...e, text })`) does, which puts the text into the user's prompt row and is visible in the transcript. `turn.step` carries `{ turnId, index, model, effort, messageCount }`, `session.start` `{ cwd, surface, isInteractive }` (not raised on `/clear`).
- Rejected: the `prompt.submit` carrier (rule appended to the first typed prompt, again after `session.end` and a shrinking `messageCount`): it works, but shows up in the transcript and is absent before the first prompt.
