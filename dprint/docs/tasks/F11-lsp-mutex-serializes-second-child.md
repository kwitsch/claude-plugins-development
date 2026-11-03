---
id: F11
title: Do not replace the per-client format queue or the second file_changed child
status: open
priority: none
area: dprint/src/mcp/lsp.mts (DprintLsp.queue, DprintLsp.format), dprint/src/mcp/format.mts (client, fileChanged key "\0file_changed")
---

# F11 Do not replace the per-client format queue or the second file_changed child

## Status

Open, verdict REFUTED (worth fixing: no). Nothing to implement. Only optional hardening (comment reword + regression test) remains.

## Problem

Hypothesis: `DprintLsp.format` serializes every request on one promise chain (`queue`), while `dprint lsp` could run requests concurrently; the second child per cwd (`client(sc.root, sc.root + "\0file_changed")`) was thought to exist only as a workaround and to halve `MAX_CLIENTS` (8) to 4 cwds. Proposed fix: per-URI queue Map plus one child per cwd.

## Evidence

- Real dprint 0.64.3, 50 x 500-line docs on distinct URIs: serialized 397 ms vs concurrent 123 ms (3.2x), results byte-identical. Speedup is real but irrelevant, see below.
- dprint lsp queues requests internally: a format_pre Edit sent 5 ms into a 50-doc burst on one shared concurrent child waits for the whole burst (127 ms small burst, 6.3 s all-dirty burst; 747 ms end-to-end for 3000-line files vs 24 ms idle). The second child keeps that lsp part at 10-13 ms. A plugin-side priority lane cannot fix it (the blocking queue is inside dprint).
- Memory inverts: the concurrent child's high-water RSS grows 1.6-3.4x and never decays (3000-line burst: 25 -> 57 MB serialized vs 25 -> 153 MB concurrent); end-to-end peak 47 vs 60 MB for a small burst, 153 vs 90 MB after one 3000-line burst. Child CPU +10-30%, threads 11-13 -> 16-20.
- FileChanged has no decision control; a 50-file burst of realistic files finishes in 0.3-0.55 s either way.
- The ~180 ms format_pre slowdown during a FileChanged burst came from 100 concurrent git spawns (control run with nothing formatted: 184-202 ms), not from lsp. That was addressed by F13.

## Code locations

- `DprintLsp.format` / `queue` in dprint/src/mcp/lsp.mts: client-wide FIFO chain (keep).
- `client(cwd, key)` and `MAX_CLIENTS` in dprint/src/mcp/format.mts: `fileChanged` passes `sc.root + "\0file_changed"` as key so whole-file formats never queue in front of `formatPre` (keep).

## Approach

No code change. Do NOT adopt per-URI concurrency and do NOT drop the `\0file_changed` child.
Optional hardening, not validated: (1) reword the `client` TSDoc to say dprint lsp queues requests internally, so the second child is required for format_pre latency; (2) add a test that `fileChanged` and `formatPre` use distinct children (current tests stay green if the isolation is removed).

## Verification

Only if the optional test is added: in dprint/tests/mcp-server.test.mjs spawn the server with a stub `dprint lsp` that records its pid per request, run a format_pre and a file_changed in the same cwd, assert two distinct pids. Run `pnpm --filter dprint build && pnpm --filter dprint test`.

## Constraints

- Edit src/, never plugin/*.mjs; rebuild after any change.
- TSDoc required on every symbol (`pnpm lint`).
- Any change under dprint/ needs a version bump (dprint/plugin.json and dprint/package.json equal).

## Related

- F13: burst cost fixed by the slot limit and single git spawn, which is the actual lever for format_pre latency during bursts.
- F04/F12: memory growth; one concurrent child would worsen it.
