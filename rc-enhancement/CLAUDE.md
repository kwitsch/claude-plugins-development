# rc-enhancement

Mod plugin, no skills/agents, no `userConfig`. Two fixed, always-on parts of one interaction contract:

- `src/bin/session-start.ts` → `plugin/bin/session-start.mjs`: a matcher-less `SessionStart` command hook that answers the `CRITICAL RULE` as a hook JSON object (`hookSpecificOutput.additionalContext`). No matcher on purpose: `/clear` and `/compact` wipe context like a fresh start and must re-inject. Not in `src/hooks/`: every file there but the entry is bundled into `lib.mjs`.
- Source layout of the gate (`src/hooks/` → `plugin/hooks/`): `register.ts` → `register.mjs` (entry, the only module in `hooks.json`, readable; `turn.start` + `turn.complete`); `types.ts` and `gate.ts` (`GATE_REASON`, `isBareQuestion`) are bundled into one compressed `lib.mjs` (`pluginBuild.bundleHooksLib`).

Constraints:

- The gate's re-prompt (`GATE_REASON`) names the `CRITICAL RULE` of the session-start text: keep the wording in both files in step (a test checks the token on both sides).
- A turn is gated when its last non-empty line outside code fences ends in `?`, only for `reason === "answer"` main-loop turns; at most one re-prompt per user turn (`gateTurnId` + `gatePending`). State lives inside `register()`, never at module level. Mechanism, loop guard and accepted false positives: [interaction-gate.md](../development/wiki/plugins/rc-enhancement/design/interaction-gate.md).
- The rule stays a command hook: a mod has no channel for session context ([interaction-gate.md](../development/wiki/plugins/rc-enhancement/design/interaction-gate.md#rule-delivery)).
- `$.prompt.submit` is not awaited (it resolves only when the new turn starts, which waits for this turn to end).
- The gate came from `coding-toolbox` and the rule hook from the former hand-written plugin in kwitsch/claude-plugins; neither may be re-added there.
- Tests: `tests/register.test.ts` (kit against `plugin/hooks/register.mjs`), `tests/session-start.test.ts` (spawns the built script, checks the JSON and `hooks.json`). Run `claude plugin validate rc-enhancement/plugin` and a live `claude -p --plugin-dir` after a hooks change.
