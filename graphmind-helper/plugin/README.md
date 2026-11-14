# graphmind-helper

Does for Claude Code, from the plugin, what [`graphmind setup`](https://github.com/aouicher/graphmind) and `graphmind init` do, and only while the `graphmind` binary exists. The `gm-*` skills are not part of it.

## What it does

- **Binary check at session start.** The binary is the first `graphmind` on `PATH`, else `~/.graphmind/bin`, `~/.local/bin` or `/usr/local/bin`. Missing: a 15 s toast says so, and every other function of the plugin stays off (the hooks exit silently, the MCP wrapper exits).
- **The three hooks `setup` writes to `~/.claude/settings.json`**, ported to Node (no `jq`): the SessionStart briefing (status, map, priority and recent memory), the UserPromptSubmit recall (memory and code search, a save reminder every 10th prompt) and the once-per-session PreToolUse nudge towards `/gm` instead of grep/find/Explore. They act only inside a registered project.
- **Index status and init.** The MCP wrapper starts with the session: when the working directory is inside a git work tree (not `$HOME`) and `graphmind which` fails, it runs `graphmind init --skip-build` (registers the project and installs the git hooks), starts `graphmind build` in the background, and serves `graphmind mcp`.

## Already ran `graphmind setup`?

- The plugin's hooks pass when `~/.claude/settings.json` names the setup's `graphmind-*.sh` scripts, so nothing is injected twice.
- The plugin's MCP server is skipped when `~/.claude.json` already holds a `graphmind` server (init still runs). To use the plugin's server instead, remove that entry (`claude mcp remove graphmind`).
- The plugin never edits `~/.claude/settings.json` or `~/.claude.json`.

## Requirements

Node (for the hook scripts) and the `graphmind` binary.
