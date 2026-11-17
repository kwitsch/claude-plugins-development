# rc-enhancement

Mod plugin, no skills/agents, no `userConfig`. Two fixed, always-on parts of one interaction contract:

- `src/hooks/session-start.ts` → `plugin/hooks/session-start.mjs`: a matcher-less `SessionStart` command hook that prints the `CRITICAL RULE` (plain stdout is session context on SessionStart). No matcher on purpose: `/clear` and `/compact` wipe context like a fresh start and must re-inject.
- `src/hooks/register.ts` → `plugin/hooks/register.mjs`: the interaction gate (`turn.start` + `turn.complete`), the only module in `hooks.json` (`modules` next to `hooks`, as dprint does). Nothing is bundled.

Constraints:

- The gate's re-prompt (`GATE_REASON`) names the `CRITICAL RULE` of the session-start text: keep the wording in both files in step (a test checks the token on both sides).
- A turn is gated when its last non-empty line outside code fences ends in `?`, only for `reason === "answer"` main-loop turns; at most one re-prompt per user turn (`gateTurnId` + `gatePending`). State lives inside `register()`, never at module level. Mechanism, loop guard and accepted false positives: [interaction-gate.md](../development/wiki/plugins/rc-enhancement/design/interaction-gate.md).
- `$.prompt.submit` is not awaited (it resolves only when the new turn starts, which waits for this turn to end).
- The gate came from `coding-toolbox` and the rule hook from the former hand-written plugin in kwitsch/claude-plugins; neither may be re-added there.
- Tests: `tests/register.test.ts` (kit against `plugin/hooks/register.mjs`), `tests/session-start.test.ts` (spawns the built script, checks `hooks.json`). Run `claude plugin validate rc-enhancement/plugin` after a hooks change.
