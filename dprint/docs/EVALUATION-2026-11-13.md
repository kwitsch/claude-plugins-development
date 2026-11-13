# dprint MCP server evaluation 2026-11-13 (plugin 0.13.0)

Fresh measurement of the built `plugin/mcp/server.mjs` after the F01-F28 work (last changes: 0.12.1 and 0.13.0). Purpose: check that the shipped fixes hold, compare with the figures in the task documents, and record what is left.

**One machine only**: WSL2 (kernel 6.18.33.2-microsoft-standard-WSL2), 12 vCPUs, 9.7 GB RAM, ext4 work tree, Node v24.22.2, real dprint 0.64.3 from PATH (`~/.local/bin/dprint`) with `@dprint/typescript` 0.96.1 and `@dprint/json` 0.25.2 from the local plugin cache. The same machine class as the old task documents, but a different day and load; treat differences below ~20% as noise. Re-measure before relying on a number.

## How it was measured

- Scratch script outside the repo (`bench.mjs` in the session scratchpad, not committed). It creates a temp git repo (`dprint.json` with the typescript and json plugins, one commit) with: `small.ts` (14 lines, 350 B), `big.ts` (7490 lines, 205 KB, dprint-clean), `dirty500.ts` (518 lines, 12.6 KB, indentation stripped and spacing crammed: nearly every line differs from dprint's output), `dirtybig.ts` (7490 lines, 184 KB, same dirt), `huge.ts` (41906 lines, 1.15 MB), 40 small padding files, and a second repo with 50 dirs x 99 one-line `.ts` files (4951 files, the F25 layout).
- The server is spawned with `node plugin/mcp/server.mjs`, `initialize` (2025-11-25), then `tools/call` over stdio. Every latency is the client-side round trip (write request line to read answer line) with `process.hrtime.bigint()`; it includes the stdio hop and JSON encoding but no Claude Code dispatch (F22 measured ~15 ms Claude-side per `mcp_tool` hook on top).
- format_pre: 2 warm-up calls per case, then 20 reps (small), 10 (200 KB), 5 (unformatted 200 KB). Cold = first `format_pre` on a freshly started server (findDprint, `dprint lsp` spawn, wasm plugin load, git spawn), 7 fresh servers per case. Edits do not write the file, so every rep sees the same file.
- Respawn after idle exit: in-process `new DprintLsp({ cwd, idleMs: 150 })` from `plugin/mcp/lsp.mjs` (the server's 2 min `IDLE_MS` has no override); wait 400 ms (child gone: verified via `/proc/<pid>/task/*/children`), then format.
- 1 MiB guard: 5 fresh servers, one 1.15 MB Write and one Edit on `huge.ts` each; children of the server counted from `/proc`.
- FileChanged burst: 60 untracked unformatted 3-function files, 60 concurrent `file_changed` calls (`event: "change"`), a small `format_pre` Write sent 5 ms into the burst, 6 reps; every rep checked that all 60 files were rewritten on disk.
- watch-paths: `node plugin/mcp/watch-paths.mjs` with a SessionStart JSON on stdin, 15 runs per repo; `dprint file-paths` alone 10 runs.
- RSS: `VmRSS`/`VmHWM` from `/proc/<pid>/status` of the server and its `dprint` children between phases.
- Two full runs; tables show run 1 / run 2 medians (ms) where both exist, p90 in brackets.

## Results

### format_pre (Write/Edit PreToolUse)

| Case                                          | Result                         | Median ms (run 1 / run 2) | p90           |
| --------------------------------------------- | ------------------------------ | ------------------------- | ------------- |
| Cold first call, Write small (dirty)          | formatted                      | 13.5 / 13.8               | 14.8 / 14.9   |
| Cold first call, Edit small (dirty line)      | formatted                      | 14.2 / 13.6               | 16.4 / 18.0   |
| Warm Write small, dirty                       | formatted                      | 4.3 / 4.0                 | 5.0 / 4.3     |
| Warm Write small, already formatted           | `{}`                           | 3.8 / 3.6                 | 4.4 / 3.9     |
| Warm Edit small, dirty line                   | formatted                      | 4.2 / 3.9                 | 4.6 / 4.3     |
| Warm Edit small, no-op (formatted new_string) | `{}`                           | 4.0 / 3.9                 | 4.3 / 4.5     |
| Write 200 KB, already formatted               | `{}`                           | 102.8 / 100.8             | 107.7 / 102.5 |
| Write 200 KB, one dirty line                  | formatted                      | 126.8 / 125.0             | 130.4 / 127.3 |
| Edit 200 KB, dirty line                       | formatted                      | 121.0 / 120.6             | 121.9 / 123.8 |
| Edit 200 KB, no-op                            | `{}`                           | 102.8 / 103.1             | 105.0 / 105.5 |
| Edit on unformatted 518-line file             | formatted                      | 54.8 / 53.4               | 55.0 / 55.0   |
| Edit on unformatted 7490-line file            | `{}` (stderr `diff too large`) | 604.1 / 603.7             | 636.3 / 617.5 |
| Warm Write small again after the 200 KB cases | formatted                      | n/a / 4.9                 | n/a / 5.4     |

Other per-Write/Edit hooks: `file_written` small 0.2 ms, 200 KB 0.4-0.5 ms; `drain_notices` (nothing queued) 0.1 ms.

### Respawn after the idle exit (F04, in-process `DprintLsp`)

| Case                                     | Median ms (run 1 / run 2) | p90           |
| ---------------------------------------- | ------------------------- | ------------- |
| Very first format (spawn + plugin load)  | 8.3 / 8.3                 | n/a           |
| Small format, warm child                 | 1.0 / 1.0                 | 1.3 / 1.1     |
| Small format, after idle exit (respawn)  | 7.7 / 7.3                 | 7.8 / 8.1     |
| 200 KB format, warm child                | 103.1 / 100.8             | 115.2 / 109.4 |
| 200 KB format, after idle exit (respawn) | 130.3 / 130.0             | 140.7 / 132.6 |

No `dprint` child was left after the idle period. The respawn costs ~6.5 ms for a small document and ~29 ms for a 200 KB one (wasm instantiation and first parse in a cold child); it is paid once per 2 min of idleness.

### 1 MiB guard (F12)

| Case                                        | Median ms (run 1 / run 2) | p90         |
| ------------------------------------------- | ------------------------- | ----------- |
| Write 1.15 MB, first call on a fresh server | 11.9 / 13.2               | 14.5 / 14.2 |
| Edit on the 1.15 MB file                    | 0.4 / 0.3                 | 0.4 / 0.3   |

`dprint` children spawned over all 10 guarded servers: 0. Server RSS after 5 x 1.15 MB Writes: 65.1 MB (HWM 65.6-65.9). The Write cost is the 1.15 MB JSON line itself (pipe, parse, `Buffer.byteLength`), not formatting.

### FileChanged burst of 60 events (F05/F13)

| Measure                                           | Median ms (run 1 / run 2) | p90           |
| ------------------------------------------------- | ------------------------- | ------------- |
| Wall time, all 60 answered and formatted          | 266.4 / 252.7             | 286.8 / 269.0 |
| Per-event latency (360 events per run)            | 158.3 / 146.7             | 257.3 / 242.5 |
| Small `format_pre` Write sent 5 ms into the burst | 23.8 / 19.3               | 30.1 / 24.4   |
| Small `format_pre` Write after the bursts         | n/a / 4.4                 | n/a / 4.7     |

60/60 files formatted in every rep; no drop line.

### watch-paths.mjs (SessionStart/CwdChanged command hook, F25)

| Repo               | Paths | stdout | Median ms (run 1 / run 2) | p90           | `dprint file-paths` alone |
| ------------------ | ----- | ------ | ------------------------- | ------------- | ------------------------- |
| Bench repo         | 106   | 14 KB  | 57.1 / 55.5               | 61.2 / 59.3   | 7.5-7.7                   |
| 50 dirs x 99 files | 4951  | 672 KB | 167.2 / 162.7             | 169.8 / 167.8 | 23.8-25.7                 |

### bash_started/bash_finished (PostToolUse Bash; new in this evaluation)

| Case                                                                    | Median ms (run 1 / run 2)   | p90         |
| ----------------------------------------------------------------------- | --------------------------- | ----------- |
| 4951-file repo, first Bash call (lists the files)                       | 135.3 / 127.9 (single call) | n/a         |
| 4951-file repo, later Bash calls (cached list, one `statSync` per file) | 14.4 / 14.1                 | 15.1 / 15.0 |
| Bench repo (106 files), later Bash calls                                | 0.5 / 1.3                   | 0.5 / 1.6   |

Per-`statSync` cost, same probe loop as `bashFinished`'s filter: ext4 3-5 us; 9P (`/mnt/c/Windows/System32`, 2000 entries, read-only) 1.53-1.59 ms unpinned and 0.67-0.71 ms with the process cwd on that path (the pinned state of a real session, see F27). Extrapolated to 4951 files: 16-26 ms on ext4, ~3.3 s pinned / ~7.6 s unpinned on 9P. See F29.

### Memory (F04/F12)

| Point                                                              | Server VmRSS MB (run 1 / run 2) | Children                                     |
| ------------------------------------------------------------------ | ------------------------------- | -------------------------------------------- |
| After `initialize`                                                 | 54.8 / 54.7                     | none                                         |
| After the format_pre phase (~155 calls, 55 with ~200 KB documents) | 96.7 / 88.6 (HWM 95.4)          | format_pre `dprint lsp` 104.3 MB (HWM 111.3) |
| After 6 x 60-event bursts                                          | 98.8 / 95.8                     | + file_changed `dprint lsp` 22.0-22.2 MB     |
| After the bash phase (4951-entry watch list cached)                | 109.9 / 111.0                   | unchanged                                    |
| Fresh server after 5 x 1.15 MB guarded Writes                      | 65.1 / 65.1                     | none                                         |

## Comparison with the task documents

| Measure                                          | Earlier figure (doc)                                                                            | Now                                                                            | Verdict                                                                              |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Small Write/Edit, server side                    | 7.6-10.7 ms in a real session (F22); 5.0 ms bench, 50-line no-change Write (F07)                | 3.6-4.3 ms                                                                     | Same order; the stdio-only harness has no Claude-side dispatch                       |
| First format_pre of a session                    | 18-19 ms (F22, real session)                                                                    | 13.5-14.2 ms (fresh server)                                                    | Consistent                                                                           |
| No-change Edit, whole-document format            | ~0.33-0.45 ms/KB; 3001 lines 38 ms, 20001 lines 268 ms (F10)                                    | 0.50 ms/KB (205 KB, 7490 short lines: 103 ms)                                  | Consistent; still linear in size (F10 stays dprint-side)                             |
| Changed Edit on a clean file                     | 3000 lines 55 ms, 20000 lines 357 ms after F03                                                  | 7490 lines 121 ms                                                              | Consistent with one request per Edit (F01/F03 hold)                                  |
| Edit on an unformatted file below the diff guard | 500 lines all-dirty 93 ms before F01/F03 (F08)                                                  | 518 lines 53-55 ms                                                             | Improved (one request; dirt pattern differs, F09: cost follows the amount of change) |
| Edit on an unformatted file above the diff guard | >= ~5000-line span: one format wasted, `{}` (F08; 20000 lines 819-955 ms)                       | 7490 lines 604 ms, `{}`, every Edit                                            | Unchanged by design (F08 docs-only)                                                  |
| First format after an idle exit                  | ~9 ms (F04 prototype b)                                                                         | 7.3-7.7 ms small, +29 ms at 200 KB                                             | Consistent; F04 cost is small                                                        |
| Guarded oversize Write                           | 10 MB call 72-220 ms, RSS 124-135 MB (F12 prototype, 2 MB cap)                                  | 1.15 MB: 12-13 ms, 0 spawns, RSS 65 MB                                         | Guard works as shipped                                                               |
| FileChanged burst                                | 100 one-liners 545 ms, 120 x 150-line 1.5 s (F05); format_pre during burst 21-26 ms (F13 final) | 60 x 3-function files 253-266 ms; format_pre during burst 19-24 ms (p90 24-30) | Consistent; F13's pass criterion (< 30 ms) holds at the median, p90 touches it       |
| watch-paths, ~5k files                           | 457 ms original, 286 ms with `realpathSync.native` (F25)                                        | 163-167 ms                                                                     | Better than F25's own figure (machine load; same code since 0.12.1)                  |
| watch-paths, small repo                          | 39 files 83-86 ms (F25)                                                                         | 106 files 55-57 ms                                                             | Better (same caveat)                                                                 |
| Server RSS baseline / after large payloads       | 55-65 MB; 5 x 1 MB 90-108 MB (F12)                                                              | 55 MB; ~89-97 MB after 200 KB payloads, 110 MB with a 5k watch list cached     | Consistent; small Write +0.4-0.9 ms after (F12: 10 x 100 KB no penalty)              |
| dprint lsp child RSS                             | 500 KB .ts 180-290 MB (F04)                                                                     | 205 KB .ts 104 MB, released after 2 min idle                                   | Consistent; now bounded in time                                                      |
| file_written                                     | 0.5-1.3 ms (F22, real session)                                                                  | 0.2-0.5 ms                                                                     | Consistent                                                                           |

## Remaining findings

- **F24 (open, priority medium)**: unchanged. `fileChanged` still ignores `unlink`, and `watch-paths.mjs` and the `bash_finished` watch cache list files once per cwd. Not measurable offline: it needs a live `claude -p --plugin-dir dprint/plugin --debug` run with an inotify sampler (see its document). Nothing in this run changes its priority.
- **F28 (partial, priority low)**: remaining gaps unchanged and confirmed against the test names: hanging `initialize` through the server (cooldown after an initialize timeout at server level), slow git (10 s `execFile` timeouts fail open), dprint stderr forwarding to the server's stderr, two JSON-RPC requests in one stdin chunk. New gap from this run: no test pins the cost or the blocking behavior of the `bash_finished` watch-list scan (F29).
- **F29 (new, open, priority low)**: `bash_finished` runs one synchronous `statSync` per cached watch-list file on every Bash call. 14 ms per Bash call on a 4951-file ext4 repo, but on a 9P repo (`/mnt/c/...`) the same loop extrapolates to ~3.3 s per Bash call (cwd pinned) and blocks the server event loop meanwhile (concurrent `format_pre` and `file_changed` wait). The first Bash call per cwd also pays the listing plus `inScope` (128-135 ms at 4951 files on ext4). Detail: [tasks/F29-bash-finished-stat-scan.md](tasks/F29-bash-finished-stat-scan.md).

Observed, no new finding:

- The unformatted 7490-line Edit wastes ~0.6 s per Edit and returns `{}` (F08; the plugin README tells users to run `/dprint:dprint fmt` once on such files).
- Server RSS climbs from 55 to ~90-110 MB within a session of 200 KB payloads and a large cached watch list and does not shrink; the measured spawn penalty is below 1 ms (F12 accepted this).
- The format_pre `dprint lsp` child holds ~104 MB after a 200 KB document until the 2 min idle exit (F04 by design).
