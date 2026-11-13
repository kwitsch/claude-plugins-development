---
id: F12
title: Bound MCP server RSS growth from multi-MB payloads
status: done
priority: low
area: dprint/src/mcp/format.mts (fileChanged, MAX_CHANGED_BYTES, formatPre), dprint/src/mcp/server.mts (tools/call response), dprint/src/mcp/lsp.mts (send, onData)
---

# F12 Bound MCP server RSS growth from multi-MB payloads

## Status

Done in 0.13.0: `formatPre` skips Write content and Edit targets (file size plus new_string) above `MAX_CHANGED_BYTES` (1 MiB) before any git or lsp spawn (`overCap`, shared with `formatOnDisk`); the document passes through unformatted. The double serialization in server.mts is required by the dual-era rule and stays. Test: "Write and Edit above 1 MiB pass through unformatted without spawning dprint lsp".

Earlier state: Partial. Mitigated: `fileChanged` skips files above `MAX_CHANGED_BYTES` (1 MiB, stderr line) and the FileChanged spawn count per event dropped from two git spawns to one (F13). NOT addressed: multi-MB Write/Edit payloads in `formatPre`, double serialization in server.mts, send/receive buffer churn.

## Problem

The stdio MCP server lives for the whole session and V8/glibc do not return memory. After large payloads RSS stays high (baseline 55-65 MB; after 3 x 10 MB Writes 150-326 MB, after 5 x 1 MB 90-108 MB; after one 6.5 MB file_changed 271 MB). Spawn cost scales with glibc main-arena (`[heap]`) bloat from freed Buffers: raw `spawn()` sync part 1.2 ms at 52 MB vs 17-36 ms at 350-820 MB; hook level 2.5-3.5x (format_pre 4.3 -> 8.5-13 ms, file_changed 7.2 -> 16.6-22 ms) for the rest of the session. Every format_pre spawns git once, every file_changed once (formerly twice).

## Evidence

- Real dprint, built server over stdio: 3 x 10 MB TS Write -> RSS 252-316 MB flat for 60 s idle, B-A +8..+10 ms (format_pre), +15..+20 ms (file_changed); 5 x 1 MB -> +1.7-3.4 ms; 10 x 100 KB -> 0 (no penalty).
- Cost tracks freed Buffers in glibc `[heap]` (3 -> 146 MB), not V8 strings: +10 x 10 MB V8 strings cost +0.9 ms per spawn, +300 MB live Buffers +27 ms. `MALLOC_MMAP_THRESHOLD_=131072 MALLOC_TRIM_THRESHOLD_=131072` removes the penalty but leaks into the dprint child (slower big formats, one 30 s timeout): rejected.
- Session (bigjson-append): 6.5 MB watched JSON appended in place -> 6.1 s hook, server RSS 57 -> 271 MB, small format_pre 8.7 -> 17.0 ms.
- Prototype 2 MB guard (formatPre content/old/new length + statSync of the Edit target, fileChanged statSync before read): a 10 MB call returns `{}` in 72-220 ms, `[heap]` stays 15 MB, penalty within noise; RSS still 124-135 MB because the 10 MB JSON-RPC line is parsed before any handler runs (harmless for spawn cost).
- Reachable multi-MB paths are only Edit on an existing >= 2 MB file and file_changed on big generated files; Write output is bounded by model output size.

## Code locations

- `MAX_CHANGED_BYTES` and `fileChanged` (`statSync(...).size` check before `readFileSync`) in dprint/src/mcp/format.mts: the guard that exists.
- `formatPre` in dprint/src/mcp/format.mts: no size guard (open).
- tools/call response builder in dprint/src/mcp/server.mts: puts `JSON.stringify(result)` in content text AND `structuredContent` (response 1.8-1.9x content bytes).
- `DprintLsp.send` / `onData` in dprint/src/mcp/lsp.mts: per-message Buffer copies (see F18).

## Approach

Remaining optional work, lowest value first:

1. In `formatPre`, return `{}` with one stderr line when `content`/`old_string`/`new_string` length or `statSync(file).size` of the Edit target exceeds a cap (1-2 MiB; reuse `MAX_CHANGED_BYTES` or a sibling constant). Sold as a stall guard: a 10 MB TS format takes ~21 s against the 30 s lsp timeout.
2. In `onData`, set `this.buf = Buffer.alloc(0)` when `end === buf.length` so a zero-length subarray does not pin the last response's backing store (unmeasured).
3. Do not set malloc env vars in .mcp.json. Do not expect RSS < 100 MB from the guard.
   Trap: a guard changes behavior (big files no longer formatted by Write/Edit); document in README.

## Verification

- Test in dprint/tests/mcp-server.test.mts: format_pre Write with content just above the cap returns `{}` and spawns no dprint lsp; the existing "file_changed skips files above 1 MiB" test covers the FileChanged side.
- Measure: spawn server, 3 x 10 MB Write, sample VmRSS from /proc/<pid>/status, compare format_pre medians before/after.
- `pnpm --filter dprint build && pnpm --filter dprint test`.

## Constraints

- Edit src/, never plugin/*.mjs; zero-dep node: builtins; TSDoc on every symbol (`pnpm lint`); fail open on every error; any change under dprint/ needs a version bump (dprint/plugin.json and dprint/package.json equal).

## Related

- F04: the FileChanged size guard (done) is the shared fix.
- F18: quadratic onData concat, source of the `[heap]` churn.
- F13: single git spawn lowers the per-event spawn penalty.
