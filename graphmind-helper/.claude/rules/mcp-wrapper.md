---
paths:
  - "src/bin/**"
  - "plugin/.mcp.json"
  - "tests/mcp.test.ts"
---

# Rule: the MCP wrapper (`src/bin/mcp.ts`, `common.ts`)

- The wrapper runs `init --skip-build`, a detached `build`, then `graphmind mcp` with inherited stdio. It passes graphmind's own server through, so the repo's dual-era MCP rule does not apply. `findGraphmind` takes `binaryDirs` from `@shared/graphmind-paths.js`, the list the hooks helper uses too ([design](../../../development/wiki/plugins/graphmind-helper/design/decisions.md)).
- Without the binary the wrapper exits 1 (the server shows as failed in `/mcp`).
- Init stays in the wrapper (before the server starts); guarded: inside a git work tree, not `$HOME`, only when `graphmind which` fails.
- graphmind 0.3.7's `init` (and `register`) runs its one-time auto-setup (stamp `~/.graphmind/auto-setup.stamp`; a pre-made empty stamp does not stop it): setup's hooks, scripts, `gm-*` skills and `~/.claude/CLAUDE.md`, always under `~/.claude` (it ignores `CLAUDE_CONFIG_DIR`), plus a `graphmind` MCP entry for opencode in `~/.config/opencode/opencode.jsonc`.
- Every init (not stamp-guarded) adds a project-scoped `graphmind` server for that repo through `claude mcp add` to `~/.claude.json` (`$CLAUDE_CONFIG_DIR/.claude.json` when set), so from that repo's next session the wrapper steps aside (`claude mcp remove graphmind` there undoes it for that repo only).
- So after the first init the dedupe turns the module off and setup's hooks run, but only when `CLAUDE_CONFIG_DIR` is unset (with it set, neither Claude Code nor the dedupe reads `~/.claude/settings.json`, so the module stays active). Documented in the README, no workaround in code (verified 2026-11-14 with a temp `HOME`).
