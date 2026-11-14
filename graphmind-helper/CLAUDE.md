# CLAUDE.md — graphmind-helper

`plugin/` is the installable plugin. `plugin/.claude-plugin/plugin.json` and all `plugin/**/*.mjs` are build output of `src/` and `package.json` (`pnpm build`); do not edit them.

## Components

- `src/hooks/notice.mts`: function-hooks module (`hooks.json` `modules`), a toast at `session.start` when no graphmind binary exists. Structural engine types, no imports (model: `dprint/src/hooks/notice.mts`).
- `src/bin/gm-session.mts`, `gm-prompt.mts`, `gm-search.mts`: command hooks, Node ports of the scripts `graphmind setup` installs as `~/.claude/hooks/graphmind-{session,prompt,search}.sh` (checked against graphmind on 2026-11-14). Keep behaviour in step with those scripts; state lives in `~/.graphmind/hook-state/<session>` as theirs does.
- `src/bin/common.mts`: binary lookup, `which`, the two "setup already ran" checks (settings hooks, `~/.claude.json` MCP entry), shared output helpers.
- `src/bin/mcp.mts` + `plugin/.mcp.json`: wrapper that runs `init --skip-build`, a detached `build`, then `graphmind mcp` with inherited stdio. It is a pass-through to graphmind's own server, so the repo's dual-era MCP rule (`.claude/rules/mcp-dual-era.md`) does not apply: graphmind answers the protocol.

## Decisions

- Init runs in the MCP wrapper (ordering before the server start), not in a session hook; `--skip-build` keeps it under the MCP startup timeout, the graph builds detached.
- Init is guarded: inside a git work tree and not `$HOME`, and only when `graphmind which` fails. The setup-MCP check comes after init so setup users still get indexing.
- No graphmind binary: hooks exit 0 silently, the wrapper exits 1 with a stderr line (the server shows as failed in `/mcp`), the toast explains.

## Tests

`tests/*.test.mts` spawn the built `.mjs` with JSON on stdin, a fake `graphmind` shell script on `PATH` and a temp `HOME`.
