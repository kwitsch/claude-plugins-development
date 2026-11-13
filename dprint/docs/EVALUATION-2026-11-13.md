# dprint MCP server evaluation 2026-11-13 (plugin 0.13.0, re-run on 0.13.2)

Fresh measurement of the built `plugin/mcp/server.mjs` after the F01-F28 work (last changes: 0.12.1 and 0.13.0). Purpose: check that the shipped fixes hold, compare with the figures in the task documents, and record what is left. The same day the measurement was repeated on 0.13.2 after the bug hunt: see [Re-run on 0.13.2](#re-run-on-0132) and [Bug hunt](#bug-hunt).

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

## Re-run on 0.13.2

Same machine, same day (load average ~0.8-1.0 during the runs), same fixtures, real dprint 0.64.3, against the built `plugin/mcp/server.mjs` of 0.13.2 (stderr `running (v0.13.2)`). Code changes on the measured paths since 0.13.0: idle-exit client `close()` and no pinned reply buffer in `DprintLsp`, `git status --literal-pathspecs`, BOM-keeping decoder and a mixed-line-ending check in the on-disk format, empty-`new_string` Edit widening, JSON-quoted notice names, per-call Bash start keys (`tool_use_id`) with an hourly prune, `bash_finished` on PostToolUseFailure, server answers its own `protocolVersion`. `watch-paths.mjs` and `watch-list.mjs` are unchanged since 0.12.1 (`git diff`). Harness: `bench2.mjs` (scratchpad copy of `bench.mjs`) differs only in the Bash phase: every `bash_started`/`bash_finished` pair carries its own `tool_use_id` and `hook_event_name: "PostToolUse"` (without them 0.13.2 keys all calls of a session alike, as 0.13.0 did), 15 instead of 11 later calls, and a new cold case (7 fresh servers, `initialize`, first Bash call in the 4951-file repo, then a second one). Two full runs; medians run A / run B, p90 in brackets; 0.13.0 medians (run 1 / run 2) from the tables above for comparison. Single machine: differences below ~20% are noise.

### format_pre

| Case                                          | 0.13.2 median ms (A / B) | p90 (A / B)   | 0.13.0 median |
| --------------------------------------------- | ------------------------ | ------------- | ------------- |
| Cold first call, Write small (dirty)          | 13.9 / 14.0              | 14.4 / 15.6   | 13.5 / 13.8   |
| Cold first call, Edit small (dirty line)      | 14.3 / 14.2              | 15.3 / 17.4   | 14.2 / 13.6   |
| Warm Write small, dirty                       | 4.0 / 4.3                | 4.5 / 4.5     | 4.3 / 4.0     |
| Warm Write small, already formatted (no-op)   | 3.7 / 3.9                | 4.3 / 4.3     | 3.8 / 3.6     |
| Warm Edit small, dirty line                   | 3.9 / 4.0                | 4.1 / 4.2     | 4.2 / 3.9     |
| Warm Edit small, no-op (formatted new_string) | 3.7 / 4.2                | 4.0 / 4.9     | 4.0 / 3.9     |
| Write 200 KB, already formatted               | 103.7 / 104.5            | 108.2 / 108.4 | 102.8 / 100.8 |
| Write 200 KB, one dirty line                  | 129.2 / 128.3            | 135.7 / 130.3 | 126.8 / 125.0 |
| Edit 200 KB, dirty line                       | 126.3 / 121.5            | 136.0 / 123.1 | 121.0 / 120.6 |
| Edit 200 KB, no-op                            | 103.4 / 101.3            | 105.0 / 104.3 | 102.8 / 103.1 |
| Edit on unformatted 518-line file             | 55.9 / 54.9              | 61.3 / 56.5   | 54.8 / 53.4   |
| Edit on unformatted 7490-line file (`{}`)     | 604.5 / 606.4            | 612.3 / 608.8 | 604.1 / 603.7 |
| Warm Write small again after the 200 KB cases | 4.8 / 4.9                | 5.5 / 5.6     | n/a / 4.9     |

`file_written` small 0.2 ms, 200 KB 0.5 ms; `drain_notices` (empty) 0.1-0.2 ms. Same results (formatted or `{}`) as on 0.13.0 in every case.

### Idle respawn, 1 MiB guard, FileChanged burst

| Case                                                | 0.13.2 median ms (A / B) | p90 (A / B)   | 0.13.0 median |
| --------------------------------------------------- | ------------------------ | ------------- | ------------- |
| `DprintLsp` very first format (spawn + plugin load) | 8.0 / 8.0                | n/a           | 8.3 / 8.3     |
| Small format, warm child                            | 1.0 / 1.0                | 1.1 / 1.1     | 1.0 / 1.0     |
| Small format, after idle exit (respawn)             | 7.4 / 7.5                | 8.1 / 8.3     | 7.7 / 7.3     |
| 200 KB format, warm child                           | 107.2 / 98.7             | 119.2 / 105.8 | 103.1 / 100.8 |
| 200 KB format, after idle exit (respawn)            | 144.3 / 131.0            | 145.4 / 136.3 | 130.3 / 130.0 |
| Guard: Write 1.15 MB, first call on a fresh server  | 11.7 / 11.1              | 14.2 / 14.2   | 11.9 / 13.2   |
| Guard: Edit on the 1.15 MB file                     | 0.3 / 0.3                | 0.4 / 0.4     | 0.4 / 0.3     |
| Burst of 60 `file_changed`: wall time               | 254.9 / 241.9            | 288.9 / 250.2 | 266.4 / 252.7 |
| Burst: per-event latency (360 events per run)       | 153.0 / 141.9            | 250.3 / 233.3 | 158.3 / 146.7 |
| Small `format_pre` Write sent 5 ms into the burst   | 19.9 / 18.9              | 21.0 / 19.9   | 23.8 / 19.3   |
| Small `format_pre` Write after the bursts           | 4.7 / 4.6                | 5.1 / 5.3     | n/a / 4.4     |

No `dprint` child after the idle period; 0 `dprint` children over all 10 guarded servers, server RSS after 5 x 1.15 MB Writes 65.2 MB (HWM 65.9); 60/60 files formatted in every burst rep.

### watch-paths and bash_started/bash_finished (F25, F29)

| Case                                                                    | 0.13.2 median ms (A / B)     | p90 (A / B)   | 0.13.0 median               |
| ----------------------------------------------------------------------- | ---------------------------- | ------------- | --------------------------- |
| watch-paths, bench repo (106 paths, 14 KB)                              | 61.4 / 56.7                  | 67.2 / 58.2   | 57.1 / 55.5                 |
| watch-paths, 4951 paths (672 KB)                                        | 173.1 / 181.0                | 182.2 / 186.9 | 167.2 / 162.7               |
| `dprint file-paths` alone, bench repo / 4951 files                      | 9.1 / 8.1 and 26.7 / 27.6    | n/a           | 7.5-7.7 and 23.8-25.7       |
| 4951-file repo, cold: fresh server, first Bash call (7 servers per run) | 136.6 / 138.2                | 139.3 / 140.7 | not measured                |
| 4951-file repo, second Bash call on that fresh server                   | 15.1 / 15.3                  | 15.3 / 15.6   | not measured                |
| 4951-file repo, first Bash call on the long-lived server                | 125.6 / 129.6 (single calls) | n/a           | 135.3 / 127.9 (single call) |
| 4951-file repo, warm: later Bash calls (15 per run)                     | 13.9 / 14.0                  | 15.3 / 15.0   | 14.4 / 14.1                 |
| Bench repo, later Bash calls                                            | 1.4 / 1.4                    | 1.6 / 1.5     | 0.5 / 1.3                   |

9P `statSync` probe repeated (`stat9p.mjs`, `/mnt/c/Windows/System32`, 2000 entries, cwd not pinned): 1.58-1.86 ms per stat, i.e. ~7.8-9.2 s for 4951 files (0.13.0 run: 1.53-1.59 ms, ~7.6 s). The pinned case was not repeated.

### Memory

| Point                                         | Server VmRSS MB (A / B)                       | Children                                                     |
| --------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------ |
| After `initialize`                            | 54.7 / 54.7                                   | none                                                         |
| After the format_pre phase                    | 93.5 / 87.4 (HWM 93.6 / 94.5)                 | format_pre `dprint lsp` 111.1 / 104.4 MB (HWM 118.2 / 111.3) |
| After 6 x 60-event bursts                     | 98.7 / 96.7                                   | + file_changed `dprint lsp` 21.9 MB                          |
| After the bash phase (4951-entry list cached) | 108.3 / 110.9                                 | unchanged                                                    |
| Fresh server after one 4951-file Bash scan    | 73.2 / 72.9 (7 servers each, p90 73.5 / 73.2) | none                                                         |
| Fresh server after 5 x 1.15 MB guarded Writes | 65.2 / 65.2                                   | none                                                         |

### Comparison with the 0.13.0 run

- **No measurable change.** Every median is within ~10% of the 0.13.0 run and most within 5%; the bug-hunt changes on the hot paths are constant-time or one linear pass over a document already in memory (flag on the git spawn, decoder flag, a regex test for mixed line endings, a string key per Bash call), far below the noise of these numbers.
- **200 KB respawn 144 ms in run A** (0.13.0: 130 ms, run B: 131 ms): the warm 200 KB format of the same run is also up (p90 119 ms vs 106 ms in run B), so it is machine load during run A, not the code (the `DprintLsp` changes only touch `close()` and the buffer reset after a reply).
- **watch-paths +4-11% on 4951 paths** (and +10% on the bench repo in run A): `dprint file-paths` alone rose by the same share (+12-16%), and the script is byte-identical since 0.12.1, so this is dprint/file-system timing on the day, not a regression.
- **format_pre during a burst** is slightly better at p90 (20-21 ms vs 24-30 ms): no code change on that path except `--literal-pathspecs`; treat it as noise. F13's < 30 ms criterion holds at p90 in both runs.
- **Bench-repo Bash calls 1.4 ms** (0.13.0 run 1: 0.5 ms, run 2: 1.3 ms): sub-millisecond spread; the 0.13.0 run-2 figure already matched.
- **New cold Bash figure**: the first Bash call per cwd on a fresh server costs 137-138 ms at 4951 files (listing + `inScope` + 4951 stats), the second already 15 ms; on a fresh server that first scan (listing plus the cached 4951-entry list) raises RSS from 54.7 to ~73 MB. The F29 numbers are unchanged: 14 ms per later Bash call on ext4, and the 9P extrapolation of ~8-9 s unpinned stands (re-probed, not measured end to end).

## Bug hunt

Four review rounds over the plugin after the 0.13.0 evaluation; every finding was fixed (code fixes with tests), none changed the numbers above.

- **0.13.1 (round 1)**, server: an evicted `DprintLsp` is closed for good instead of respawning, and an empty reply view no longer pins the whole assembled buffer; `git status` gets `--literal-pathspecs` (a glob character in a file name matched other files); the digest decoder keeps a UTF-8 BOM like `readFileSync` (digests disagreed, so BOM files were handled wrong); files with mixed line endings are not rewritten all-CRLF; `initialize` answers the server's own `protocolVersion` instead of echoing the client's. Notice hook: the worktree cwd is read from the field of the tool that fired (`worktreePath` for EnterWorktree, `restoredCwd` for ExitWorktree, also from the engine's `{ result }`); `DPRINT_INSTALL` is honored. Skill scripts: extensions matched case-sensitively like dprint, a BOM config is reported as unusable (dprint rejects it), `latest.` plugin URLs count as configured, `findDprint` honors `DPRINT_INSTALL`; README fixes.
- **0.13.2 (rounds 2 and 3)**: `close()` also stops a spawn that is still waiting for the dprint lookup; an Edit with an empty `new_string` also removes the following line break, as Claude Code does; file names in notices are JSON-quoted (a name could hold a newline or read like an instruction); the Bash start time is keyed per call (`tool_use_id`, new hook input), so overlapping Bash calls of one session keep their own window; `bash_finished` reports a `file_changed` reformat that finished mid-Bash after running its own formats (race); `bash_finished` also runs on PostToolUseFailure (a Bash call exiting non-zero) and answers with that event name; Bash start entries that never finish are pruned after an hour. Tests added for the review gaps (hooks.json wiring, the race, closed client, `initialize`, `DPRINT_INSTALL`).
- **0.13.2 (round 4)**: `git check-ignore` and the index check (`git status`) run on the real path: git refuses a pathspec beyond a symbolic link, so a file reached through a symlink into an ignored directory was formatted (Write/Edit) or skipped wrongly (FileChanged, `bash_finished`). Round 5 (a last independent pass over the whole plugin) found no code defect.

## Remaining findings

State after the 0.13.2 re-run.

- **F24 (done in 0.13.2 as an opt-in, after this run)**: the live smoke test confirmed it (new files never watched, watches lost after unlink+create). Re-listing from FileChanged does not fix it. Directories as `watchPaths` do: every scenario formatted in 2 of 2 live runs and the watch count stable, at the price of every event below a directory (about 100 events per second in a 3000-file burst), so it is `DPRINT_WATCH_DIRECTORIES=1`, default off. See `tasks/F24-watch-list-static-per-file.md`.
- **F28 (done in 0.13.2, after this run)**: the four remaining gaps (hanging initialize, hanging git, stderr forwarding, two requests in one chunk) have tests now.
- **F29 (done in 0.13.2, after this run)**: `bash_finished` on a file system with slow stats (a 16-file stat sample above 0.2 ms) asks git which files changed and stats only those; on a real 9P mount (`/mnt/c`, 1500-file git repo) a Bash call went from 3.7 s to 0.9 s, ext4 stays on the plain scan (14 ms; git costs 68 ms there). 9P mtimes lag the clock by about 1.5 s, so the slack there is 5 s (the 1 s slack missed changes). See `tasks/F29-bash-finished-stat-scan.md`.

Observed, no new finding:

- The unformatted 7490-line Edit wastes ~0.6 s per Edit and returns `{}` (F08; the plugin README tells users to run `/dprint:dprint fmt` once on such files).
- Server RSS climbs from 55 to ~90-110 MB within a session of 200 KB payloads and a large cached watch list and does not shrink; the measured spawn penalty is below 1 ms (F12 accepted this).
- The format_pre `dprint lsp` child holds ~104 MB after a 200 KB document until the 2 min idle exit (F04 by design).
