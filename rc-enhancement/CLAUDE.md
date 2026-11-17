# rc-enhancement

Command-hook plugin (no mods module, no skills/agents, no `userConfig`). Two fixed, always-on parts of one interaction contract, both built from `src/hooks/` to `plugin/hooks/`:

- `session-start.ts`: a matcher-less `SessionStart` hook that answers the `CRITICAL RULE` as a hook JSON object (`hookSpecificOutput.additionalContext`). No matcher on purpose: `/clear` and `/compact` wipe context like a fresh start and must re-inject.
- `stop.ts`: a `Stop` hook that blocks the end of a main-session turn once (`{ decision: "block", reason }`) when the answer's last non-empty line outside code fences ends in `?`.

Constraints:

- Both scripts live in `src/hooks/` and ship compressed: `pluginBuild.compressHookScripts: true` in `package.json` makes `development/scripts/build-plugin.ts` minify a shebang `hooks/*.mjs` like `bin/` (the default keeps `hooks/*.mjs` readable for the mods static check, which does not apply here). `hooks.json` carries no `description` and starts each script as `node "${CLAUDE_PLUGIN_ROOT}/hooks/<name>.mjs"` (node as command, script as argument; the shebang stays because the build recognises a script by it).
- The block `reason` (`REASON` in `stop.ts`) names the `CRITICAL RULE` of the session-start text and stays short: keep the wording in both files in step (a test checks the token on both sides).
- Subagents are never gated: the hook returns silently when the payload carries `agent_id`; `SubagentStop` is not wired. It also returns silently on `stop_hook_active` (at most one block per stop, also when another plugin's hook caused the continuation), on a missing `last_assistant_message` and on an unreadable payload (fails open).
- The rule stays in the session-start text, not only in the Stop reason: a rule that is absent until a violation makes the model violate far more often, and each retry costs a full request. Mechanism, cost reasoning, why this is not a mods module: [interaction-gate.md](../development/wiki/plugins/rc-enhancement/design/interaction-gate.md).
- The gate came from `coding-toolbox` and the rule hook from the former hand-written plugin in kwitsch/claude-plugins; neither may be re-added there.
- Tests: `tests/session-start.test.ts` (JSON of the built script, `hooks.json` wiring), `tests/stop.test.ts` (spawns the built script on payloads). Run `claude plugin validate rc-enhancement/plugin` and a live `claude -p --plugin-dir` after a hooks change.
