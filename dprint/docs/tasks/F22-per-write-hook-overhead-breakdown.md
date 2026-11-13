---
id: F22
title: Per-Write/Edit hook overhead breakdown (measurement baseline)
status: closed
priority: none
area: dprint/plugin/hooks/hooks.json, dprint/src/mcp/server.mts, dprint/src/mcp/format.mts (formatPre, fileWritten)
---

## Status

Closed 2026-11-13: measurement record, no code action. The baseline is out of date: Write/Edit now runs three `mcp_tool` hooks (`format_pre`, `drain_notices`, `file_written`) and each Bash call two (`bash_started`, `bash_finished`); re-measure before relying on it.

Open, docs-only. No fix proposed: this is the reference baseline for judging other changes. Analysis verdict: confirmed, not worth fixing.

## Problem

Question answered: where does the plugin's per-Write/Edit time go. Real-session cost ~40 ms (claimed ~50 ms) per small Write/Edit; only big dirty-file Edits are user-noticeable.

## Evidence

Claude Code 2.1.316, dprint 0.64.3, WSL2, headless `claude -p` sessions behind a logging stdio proxy (medians):

- Small Edit end-to-end 147-153 ms with plugin vs 111 ms without (control-noplugin): plugin adds ~36-42 ms: ~9 ms server (10-line file) to ~40 ms (331-line file), ~27-33 ms Claude-side across the two mcp_tool hooks (~15 ms each).
- Order: tool_use -> +13-14 ms -> `calling format_pre` -> server (hop 0-2 ms) -> response -> +22-23 ms (Claude applying the Edit) -> `calling file_written` -> server 0.5-1.3 ms -> tool_result. The 73-118 ms between file_written and tool_result in those runs is another plugin's synchronous PostToolUse hook (3-5 ms without it).
- format_pre server time: 10-line files 7.6-10.7 ms (first call of a session 18-19 ms: lsp spawn + plugin load), 331-line dirty 38-45 ms, 2976-line clean 28-32 ms, 2976-line all-dirty 1299-1383 ms (F08/F09), small Write during a 120-event FileChanged burst 90-96 ms (F13).
- Server budget with stub dprint ~4 ms (git check-ignore ~2.4 ms incl. spawn, lsp < 1 ms, JSON/IO < 1 ms). file_changed digest hit for Claude's own write 0.2-1 ms, 0.6-1.8 s later, asynchronous.
- Startup: MCP connect ~90 ms median (157-258 ms behind the proxy), initialize 0.7 ms.
- Critic note: the claimed "15 ms between calling and request at server" is wrong (0-2 ms); keep the corrected split above.

## Code locations

`formatPre`, `fileWritten`, `fileChanged` in dprint/src/mcp/format.mts; tool dispatch in dprint/src/mcp/server.mts; hook wiring in dprint/plugin/hooks/hooks.json (PreToolUse `format_pre`, PostToolUse `file_written`, async FileChanged `file_changed`).

## Approach

No change. Use as the comparison baseline when evaluating F21 (removing a dispatch), F07/F27 (server-side ms), F01/F03 (big-file Edit). Server-side savings below ~5 ms are invisible end-to-end; the structural floor is ~30 ms without removing a hook.

## Verification

To re-measure: run a headless `claude -p` session with the plugin dev tree (`--plugin-dir`) behind a stdio logging proxy, compare 10+ small Edits against a run without the plugin; use monotonic clocks (hrtime), never `Date.now` (WSL2 clock jumps, see F23).

## Constraints

None (no code change).

## Related

F21 (only structural saving), F23 (clock-jump caveat), F13 (burst slows concurrent format_pre), F08/F09/F10 (big-file cost).
