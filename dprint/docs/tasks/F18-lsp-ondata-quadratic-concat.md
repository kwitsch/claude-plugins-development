---
id: F18
title: Linear frame accumulation in DprintLsp.onData
status: done
priority: low
area: dprint/src/mcp/lsp.mts (DprintLsp.onData, buf, start, broken)
---

## Status

Done in 0.12.1: `DprintLsp.onData` collects chunks in `chunks` and joins once per frame (`need` = bytes still missing); test "chunked lsp frames ... reassembled byte-exact" (stub mode `chunked`, 880 KB body).

## Problem

Node delivers child stdout in <= 64 KB chunks; each chunk copies the whole accumulated partial frame: O(N^2) in response size. Micro (64 KB chunks, current vs patched, median ms): 1 MB 4.2 vs 1.5; 5 MB 53 vs 7; 10 MB 237 vs 18; 20 MB 935 vs 30. Runs on the server event loop. Real dprint: onData is <= 1.8% of any format (50000-line all-dirty doc, 3.7 MB response: 60 ms vs 7.8 ms patched; typical <= 290 KB responses 0.1-2.8 ms). Stub round trip of a 10 MB Write: -525 ms with the fix; 1 MB -15..-20 ms; 100 KB noise.

## Evidence

- Real dprint stdout chunks are 64 KB median and max (3.7 MB in 62-78 chunks); the 64 KB micro row is the real-world model.
- Patched prototype: self-check on 300 random multi-frame streams (splits of 1-40 B and 1-64 KB, 10% broken headers) produced identical onMessage/broken sequences vs the original; 123 tests green.

## Code locations

- `DprintLsp.onData`, field `buf`, resets in `start()` (`this.buf = Buffer.alloc(0)`) and `broken()` in dprint/src/mcp/lsp.mts.

## Approach

1. Replace `buf: Buffer` by `parts: Buffer[] = []`, `total = 0`, `need = -1` (body length, -1 until header parsed), `headerLen = 0`.
2. `onData`: push chunk, `total += chunk.length`. While `need === -1`: concat parts once (small), find `\r\n\r\n`, parse `content-length`; no separator -> return; no length -> `broken()`.
3. Return until `total >= headerLen + need`; then `Buffer.concat(parts, total)` ONCE, slice body, parse, carry the remainder as the single new part, reset `need`, loop for further frames.
4. Reset all four fields in `start()` and `broken()`. Also resets drop the zero-length-subarray pin on the last response's backing store (F12 note).
   Traps: header may span chunks; several frames per chunk; keep the unanchored case-insensitive `/content-length:\s*(\d+)/i` and the `broken()` behavior on bad header/JSON; keep the child-identity guard in the data handler (F19).

## Verification

- Add a unit-style test in dprint/tests/mcp-server.test.mts with a stub `dprint lsp` that writes one frame in 1-byte/64 KB splits and a response of several MB; assert the format result is correct.
- Measure: 10 MB stub response via format_pre Write, before/after (expect ~-500 ms).
- `pnpm --filter dprint build && pnpm --filter dprint test`.

## Constraints

- Edit src/, never plugin/*.mjs; zero-dep node: builtins; TSDoc on every new field and symbol (`pnpm lint`); version bump (plugin.json and package.json equal). Bundle with another lsp.mts change; do not release alone.

## Related

- F12: size guard makes this mostly moot; this is the source of its `[heap]` churn.
- F19: data handler guard must stay.
