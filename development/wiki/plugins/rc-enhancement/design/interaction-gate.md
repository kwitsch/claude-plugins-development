# Interaction gate

How rc-enhancement makes a turn that ends in a plain-text question redo it through `AskUserQuestion`, why that is a `Stop` command hook and not a mod, and where the plugin came from.

## Behaviour

- Heuristic: strip fenced code blocks, take the last non-empty line, gate when it ends in `?`. Blunt on purpose: a rhetorical trailing `?` is an accepted false positive, traded for simplicity and for matching the rule's own "no exceptions" wording.
- Main session only: the hook returns silently when the payload carries `agent_id` (a subagent's own stops are `SubagentStop` events, not wired).
- The questioning answer is not suppressed: the stop is blocked, the answer stays visible and the model continues in the same turn.

## Mechanism

- `src/bin/stop.ts` reads the Stop payload (`last_assistant_message`, `stop_hook_active`, `agent_id`) and answers `{ decision: "block", reason }` with a short reason that names the `CRITICAL RULE` of the session-start text.
- Loop guard is the platform's: `stop_hook_active` is true on the stop that follows a block (also when another plugin's hook caused the continuation), and the hook lets it through. Claude Code also ends the turn after 8 consecutive blocks.
- Live check (`claude -p --plugin-dir`, Claude Code 2.1.326, 2026-11-17): the payload keys are `session_id, transcript_path, cwd, prompt_id, permission_mode, effort, hook_event_name, stop_hook_active, last_assistant_message, background_tasks, session_crons`; a block continued the turn, the model called `AskUserQuestion` (headless: looked it up through ToolSearch), and the second stop arrived with `stop_hook_active: true`. `cc-plugin-sec-default` does not touch command hooks.

## Why a command hook and not a mod

- A user-tier mod cannot block `Stop`: `classic.Stop` is bypassed by `cc-plugin-sec-default` ([claude-code-hook-facts.md](../../../../../.claude/rules/claude-code-hook-facts.md)). The 0.3.x gate worked around it with `turn.complete` plus an unawaited `$.prompt.submit`, a loop guard of its own (`gateTurnId`, `gatePending`) and a framed plugin prompt that starts a new turn. A `Stop` command hook needs none of that: no mods module, no engine dependency, two plain scripts.
- Cost: one blocked stop costs one more request with the whole context (about 58k cache-read tokens in the live check), the same as the old re-prompt turn.

## Why the rule is still injected at session start

- The rule text is about 450 tokens, cached after the first request, so it costs the cache-read price per request. A retry costs a full request. Without the rule up front the model ends in a question far more often (its default), so the rule is cheaper than the retries it prevents. This is an estimate; the violation rate was not measured.
- The Stop reason stays short: it names the missing element and points at the rule instead of repeating it.

## Rule delivery (mod channels tried and rejected, 2026-11-17)

- Moving the rule into a mod was tried and rolled back by the user. Live probes (throwaway mod, Claude Code 2.1.326): a mod has no channel for session context. `classic.SessionStart` and `classic.UserPromptSubmit` are bypassed by `cc-plugin-sec-default` (notice `its classic.<Event> hook was skipped`), so `additionalContext` of a wrapped hook never arrives. A `turn.start` rewrite and a `turn.step` rewrite (`system`, `systemPrompt`, `additionalContext`, `context`, `appendSystemPrompt` fields) do not reach the model. Only a `prompt.submit` rewrite (`next({ ...e, text })`) does, which puts the text into the user's prompt row, visible in the transcript. `turn.step` carries `{ turnId, index, model, effort, messageCount }`, `session.start` `{ cwd, surface, isInteractive }` (not raised on `/clear`).
- The `SessionStart` command hook answers a hook JSON object (`hookSpecificOutput.additionalContext`), not plain stdout; both reach the model.

## Origin

- 2026-11-17, decided by the user: the gate moved out of `coding-toolbox` (0.26.0, kwitsch/claude-plugins PR #298) into `rc-enhancement` 0.2.0, which was then migrated into this repository as 0.3.0 with the repository's layout and the sync to kwitsch/claude-plugins. Rejected: leaving the gate in coding-toolbox (the rule and its enforcement belong together).
- Same day, 0.4.0: the mods gate became the `Stop` command hook above, main session only. `plugin/` may hold no markdown beyond the README, so the rule text is a constant in `src/bin/session-start.ts`.
