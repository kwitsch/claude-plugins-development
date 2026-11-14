# graphmind-helper

Does for Claude Code, from the plugin, what [`graphmind setup`](https://github.com/aouicher/graphmind) and `graphmind init` do, and only while the `graphmind` binary exists. The `gm-*` skills are not part of it.

## What it does

- **Binary check at session start.** The binary is the first `graphmind` on `PATH`, else `~/.graphmind/bin`, `~/.local/bin` or `/usr/local/bin`. Missing: a 15 s toast says so, and every other function of the plugin stays off.
- **The three hooks `setup` writes to `~/.claude/settings.json`**, as one Claude Code function-hooks module (no command hooks, no Node start per call). It reads graphmind through the MCP server's tools (`gm_status`, `gm_map`, `gm_memory_list`, `gm_search`):
  - the project briefing (status, map, priority and recent memory), added to the **first prompt** of a conversation as context (the server starts alongside the session, so a SessionStart hook would race it),
  - the prompt recall (memory and code search for the prompt's terms, a save reminder every 10th prompt),
  - the once-per-session nudge towards `/gm` instead of grep/find/Explore, added to the result of the first such search.
    Two things the MCP tools cannot do stay on the CLI, run without a shell: the priority memory list and `memory search --no-recall` (recall counting would promote automatically searched entries to priority).
- **Index status and init.** The MCP wrapper starts with the session: when the working directory is inside a git work tree (not `$HOME`) and `graphmind which` fails, it runs `graphmind init --skip-build` (registers the project and installs the git hooks), starts `graphmind build` in the background, and serves `graphmind mcp`. The module treats a project as indexed when `gm_status` answers for it.

## Already ran `graphmind setup`?

- The module adds nothing when Claude Code's user settings (`~/.claude/settings.json`, or `$CLAUDE_CONFIG_DIR/settings.json` when that is set) name the setup's `graphmind-*.sh` scripts, so nothing is injected twice.
- The plugin's MCP server is skipped when Claude Code's global config (`~/.claude.json`, or `$CLAUDE_CONFIG_DIR/.claude.json` when that is set) already holds a `graphmind` server (init still runs); the module then uses that server's tools. To use the plugin's server instead, remove that entry (`claude mcp remove graphmind`).
- The plugin never edits `~/.claude/settings.json` or `~/.claude.json`.

## Requirements

The `graphmind` binary and a Claude Code version with function-hooks modules (mods).
