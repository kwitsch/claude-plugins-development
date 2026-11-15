# Probing what Claude Code sends to a hook

How to find out, in a few minutes and without touching a real plugin, which fields a hook payload carries, which environment a hook process sees, and what an exit code does.

The general recipe for real sessions is the `live-verify` skill; this page is the smaller tool for "what does the payload look like". Results belong in [claude-code-tool-hook-facts.md](../../../.claude/rules/claude-code-tool-hook-facts.md) or a facts page.

## The probe

- A throwaway plugin in the session scratchpad: `.claude-plugin/plugin.json` (`name`, `version`, `description`), `hooks/hooks.json` wiring the events in question to one `node "${CLAUDE_PLUGIN_ROOT}/hooks/log.mjs"`, and `log.mjs`, which reads stdin with `await json(process.stdin)` and appends one JSON line per call to a file named by an environment variable of the test run.
- Cut long values before logging (`tool_response.originalFile`, `transcript_path`) and log only the names of nested objects' keys; add the `CLAUDE*` environment variables, leaving out any whose name contains `KEY`, `TOKEN` or `SECRET`.
- To test what an exit code does, let the probe exit 2 with a recognisable instruction on stderr (`append the line FIXED-<event> to <file>`) exactly once per event and agent, using a marker file. The file content afterwards shows who received the text and acted on it.

## The run

- A throwaway git repository in the scratchpad, then `claude -p --plugin-dir <probe> --setting-sources project --debug-file <log> --allowedTools "<only what the steps need>" --max-budget-usd 1 "<exact tool steps; end with: Reply with the single word done.>"`. `--setting-sources project` keeps the user's installed plugins and settings out.
- For a subagent, the prompt tells the main conversation to start one general-purpose subagent with exact steps. For a workflow agent, allow `Workflow` and ask for an inline script with one `agent()` call; this needs a higher budget (2 USD was enough).
- Put the whole run into one script file and start it with one plain command; a worktree session refuses compound commands.
- A linter stub for plugin runs: a script named like the linter, first on `PATH` of the `claude` process, that logs each call with the file's content at that moment and prints findings for marker lines. The log shows when a lint really ran, which the debug log's hook status lines alone do not.

## Reading the result

- The probe's JSON lines give the fields per event; compare the main conversation's payload with the subagent's.
- `grep -E "finished with status|Hook .* error" <debug log>` gives each hook's exit status and duration.
- Headless runs do not background `async` hooks, so timing seen there says nothing about an interactive session.
