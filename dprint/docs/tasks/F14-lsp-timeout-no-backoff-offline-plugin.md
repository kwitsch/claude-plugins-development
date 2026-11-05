---
id: F14
title: Back off after an lsp request timeout
status: done
priority: none
area: dprint/src/mcp/lsp.mts (DprintLsp.formatNow, noteTimeout, failedAt, COOLDOWN_MS, timeoutMs option)
---

# F14 Back off after an lsp request timeout

## Status

Done. After a request timeout (or an initialize timeout), formats of the SAME document (key: file URI, per `DprintLsp` client) fail at once for 60 s (`COOLDOWN_MS`). Test-only constructor option `timeoutMs` (default 30 s `REQUEST_TIMEOUT_MS`). Not done: capping `dprint file-paths` in watch-paths.mts at ~3 s (see Approach).

## Problem

`dprint lsp` answers initialize at once but resolves/downloads plugins on the first formatting request and retries on every format. With a silently dropping plugin host (DROP firewall, half-up VPN, unreachable HTTPS_PROXY) and a cold plugin cache, every format stalls for the full 30 s request timeout, the child is killed and respawned with no memory of the failure, and queued requests serialize at 30 s each (k queued FileChanged events cost k x 30 s, blowing the 60 s hook timeout). `formatPre` fails open with `{}` and nothing is shown, so every Write/Edit takes 30 s for the session. Plain offline is NOT a trigger (DNS fails in ~2-42 ms); a 404 plugin costs ~0.46 s per format and reads as "already formatted" (not addressed).

## Evidence

- Baseline server, blackhole plugin URL (`https://10.255.255.1/plugin.wasm`, empty `DPRINT_CACHE_DIR`): 3 Writes 30024 / 30012 / 30011 ms; burst of 3 concurrent formats settled at 30 / 60 / 90 s.
- Real session: two one-line Edits 30.0 s each, session wall 81.8 s; SessionStart `watch-paths.mjs` stalled 10.08 s (its `execFileSync` timeout) because `dprint file-paths` hangs.
- 5-line cooldown prototype: 30020 / 4 / 4 ms for three Writes; burst settles at 30 s together; 123 tests green. `dprint check` itself hung > 106 s.

## Code locations

- dprint/src/mcp/lsp.mts: `REQUEST_TIMEOUT_MS`, `COOLDOWN_MS`, `TimeoutError`, `DprintLsp.failedAt` (Map uri -> `Date.now()` of last timeout, pruned in `noteTimeout`), `formatNow` (throws "dprint lsp: cooling down after a timeout"), `noteTimeout`, constructor `opts.timeoutMs`.
- `start()` rejects an initialize timeout; `formatNow` routes it through `noteTimeout` too.
- dprint/src/mcp/watch-paths.mts: `execFileSync` timeout (10 s) for `dprint file-paths`, unchanged.

## Approach

Implemented per document, not per client, so one slow document does not block others. Rejections surface as `{}` plus one stderr line via `formatPre`/`fileChanged` fail-open. Do not lower `REQUEST_TIMEOUT_MS` (10 s variant not validated).
Open follow-up (low): in watch-paths.mts lower the `execFileSync` timeout for `dprint file-paths` to ~3 s (healthy answer takes 9-10 ms); on timeout it already prints nothing.

## Verification

- tests/mcp-server.test.mts: "lsp timeout -> later formats of that document fail fast for the cooldown, other documents do not" (uses a stub lsp and `timeoutMs`).
- Real repro: fixture with dprint.json plugin `https://10.255.255.1/plugin.wasm`, `DPRINT_CACHE_DIR` empty; time three format_pre calls; expect ~30 s then ~4 ms.
- `pnpm --filter dprint build && pnpm --filter dprint test`.

## Constraints

- Edit src/, never plugin/*.mjs; fail open; TSDoc on every symbol; version bump for any further change.

## Related

- F19: stale-stdout race after a timeout (fixed).
- F25: watch-paths timing; F28: injectable timeout enables the tests.
