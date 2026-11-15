---
paths:
  - "src/hooks/**"
  - "tests/register.test.mts"
  - "tests/terms.test.mts"
---

# Rule: the hooks module (`src/hooks/register.mts`, `terms.mts`)

- Tool names differ per server: the plugin's own is `mcp__plugin_graphmind-helper_graphmind__gm_*`, a `graphmind setup` server `mcp__graphmind__gm_*`. `resolveTools` matches the `__gm_*` suffix on a server whose name holds `graphmind`, the plugin's own first, so both work.
- Readiness = `gm_status` with `project: <session cwd>` answers (it errors "not registered" otherwise); positive answers are cached for the conversation, negative ones 30 s (the wrapper may register the project a moment later). Tool listing cached 30 s once found (no engine event reports a changed list).
- The briefing waits for the first `prompt.submit`: the MCP server starts concurrently with `session.start`.
- Without the binary the module adds nothing (the toast explains).
- Dedupe: the module adds nothing when the user settings (`~/.claude/settings.json`, or `$CLAUDE_CONFIG_DIR/settings.json` when that is set) name the setup's scripts (read once per conversation).
- `$.tool.call` and `$.process.run` run in-frame of a hook (permission checks otherwise prompt); all of them are awaited inside `prompt.submit`/`tool.call`. Every failure fails open (the prompt or result passes unchanged).

## Engine facts (checked live with `claude -p`, Claude Code 2.1.325)

- The module loads as `graphmind-helper@inline` (events session.start, session.end, prompt.submit, tool.call); the plugin's MCP server connects as `plugin:graphmind-helper:graphmind` and `$.tool.call` reaches its tools as `mcp__plugin_graphmind-helper_graphmind__gm_*`.
- A real MCP tool result is `{ result: [{ type: "text", text }], text }`, not a string (a build that read only strings silently added nothing): `textOf` reads `text`, then a string `result`, then the text parts.
- The first-prompt briefing (a `context` entry returned from `prompt.submit`) reaches the model verbatim; the nudge (`context` on a `tool.call` result) reaches it as "tool.call hook additional context".

## Live harness

- Keep setup's hooks out with a temp `HOME`, a `CLAUDE_CONFIG_DIR` without them and `--setting-sources project`: the module reads `$CLAUDE_CONFIG_DIR/settings.json`, else `~/.claude/settings.json`, and stays silent (correctly) when they name the setup scripts. Copying the credentials into a scratch config dir was refused by the auto-mode classifier, so a live re-run needs the user.
- The last live run predates the parallel-recall refactor and the `CLAUDE_CONFIG_DIR` dedupe fix; since then only the kit tests ran. Not exercised live yet: a `graphmind setup` server (`mcp__graphmind__*`, kit test only), the setup-hooks dedupe, an unregistered project and init, the 10th-prompt checkpoint.
