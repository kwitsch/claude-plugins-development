---
id: F21
title: Evaluate folding the file_written hook into format_pre
status: open
priority: low
area: dprint/src/mcp/format.mts (fileWritten, formatPre, written map), dprint/plugin/hooks/hooks.json (PostToolUse Write|Edit -> file_written)
---

# F21 Evaluate folding the file_written hook into format_pre

## Status

Open. Hypothesis, never prototyped. Analysis verdict: gate passed (saving >= 10 ms), hypothesis unvalidated (critic dispute). Not worth doing unless the ~15 ms matters.

## Problem

Every Write/Edit pays two synchronous mcp_tool dispatches on the tool's critical path: PreToolUse `format_pre` and PostToolUse `file_written`. `file_written` only records the SHA-256 digest of what Edit/Write left on disk (`written` map) so `fileChanged` leaves Claude's own write alone. Hypothesis: `formatPre` already knows the bytes that will land (Write: `out ?? content`; Edit: R, the file after the edit on its LF view), so it could record the digest and the PostToolUse hook group could be deleted. Claimed gain: about -15 ms wall per Write/Edit (a tenth of a ~150 ms Edit round trip; Claude-side cost per mcp_tool hook ~15 ms, server side 0.6-1.2 ms) plus one `readFileSync` + SHA-256, and the FileChanged-before-file_written race closed by construction.

## Evidence

- Claude Code 2.1.316 watcher uses chokidar `awaitWriteFinish {stabilityThreshold 500, pollInterval 200}`: 48/48 FileChanged echoes of Claude's own Edits arrived 586-773 ms AFTER `file_written`, never before or without; file_written costs ~0.6 ms, so the race window only opens if PostToolUse is delayed > ~600 ms (server loop blocked by huge sync lineDiff/trimToEdit, or Claude-side stall).
- Plugin share per small Edit ~36-42 ms end-to-end (150 ms with plugin vs 111 ms without), ~27-33 ms of it Claude-side across the two hooks. Note (critic): the `calling` -> server hop itself is 0-2 ms; the 13-14 ms sits between tool_use and the `calling` debug line. The 73-118 ms after file_written in those sessions was another plugin's PostToolUse hook.
- Risks named by the analysis: CRLF files (digest must be of the CRLF rendering actually written back), content Claude Code normalises on write, Edits Claude Code rejects (e.g. old_string not unique) or a denied tool call leave a stale record (harmless: a later real change mismatches the digest), Write/Edit with no updatedInput.

## Code locations

- `fileWritten` in dprint/src/mcp/format.mts: scopeOf, inScope, findConfig gate, `written.set(s.real, digest(readFileSync(...)))`.
- `written` (Map real path -> digest), checked in `fileChanged` before any spawn and again after the awaits.
- `formatPre` in dprint/src/mcp/format.mts (Write: formatted content; Edit: `trimToEdit` result, CRLF handling).
- dprint/plugin/hooks/hooks.json: PostToolUse `Write|Edit` group, tool `file_written`; tool table typed by `HookInputs` in dprint/src/mcp/server.mts (generated dprint/src/mcp/hook-inputs.d.mts).

## Approach

Prototype FIRST in a scratch copy; decision it gates: whether to delete the hook or keep it.

1. In `formatPre`, after computing the content that will be written, `written.set(real, digest(<exact bytes Claude Code will write>))`. Edit: apply the returned old/new to the file text yourself and render with the file's own line endings; compare against the actual on-disk result in a real headless `claude -p` session (CRLF file, non-unique old_string, replace_all, file with BOM).
2. Safer alternative from the analysis: keep `file_written` and record in `formatPre` as well (belt and braces); gains only the closed race, not the 15 ms.
3. Only if the record is provably byte-identical in all cases, delete the PostToolUse hook group and the `file_written` tool (hooks.json, server.mts tool table; `scripts/hooks.mjs` regenerates hook-inputs.d.mts). Update CLAUDE.md and tests that call `file_written`.
   Trap: a record made at PreToolUse time must not outlive a failed Edit in a way that suppresses a real later change; the digest mismatch makes this safe only if the digest is of the exact post-write bytes.

## Verification

Existing test "file_written records the Edit/Write result: file_changed leaves it alone, also on repeated events" in dprint/tests/mcp-server.test.mjs must keep passing (or be rewritten against format_pre). Add: CRLF Edit then file_changed -> file untouched; rejected Edit -> later real change is still formatted. Real-session check: Write/Edit with edits-style prompts, confirm no whole-file reformat after the FileChanged echo and measure Edit wall vs baseline (~147-153 ms).

## Constraints

Edit src/ and hooks.json (hand-written, in plugin/hooks/), not plugin/*.mjs; `pnpm --filter dprint build && pnpm --filter dprint test`; fail open; TSDoc on every symbol; version bump in dprint/plugin.json AND dprint/package.json.

## Related

F22 (the ~50 ms per-edit budget this would reduce), F23 (refuted gap after updatedInput), F24 (FileChanged coverage: the digest only matters for watched files).
