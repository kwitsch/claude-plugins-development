---
id: F25
title: Bound digest hashing and FileChanged lint by file size
status: done
priority: low
area: universal-lint/docs/tasks/F25-digest-size-bound.md, universal-lint/docs/TASKS.md
---

## Status

Closed docs-only in 0.15.22. Hashing a 10 MB file costs about 11 ms against a 30-55 s lint budget, and the real digest store holds 6 files / 28 KB. A size skip is not a hashing saving: with no digest written, FileChanged lints the file (a new duplicate lint), and skipping the lint itself drops findings that F19 (generated files stay linted) decided to keep. No code shipped. 0.15.22 because the root CLAUDE.md version rule applies to any change under `universal-lint/`.

## Problem

`fileDigest` reads the whole file into memory and hashes it with no size cap, for every in-scope Write/Edit and every FileChanged with a stored digest; huge files then go on to a lint of dubious value.

## Evidence

sha256(readFileSync), median of 5: 1 MB 1.3 ms; 10 MB 11.7 ms (115 MB RSS); 50 MB 60-63 ms (199-200 MB RSS); 200 MB 244 ms (450 MB RSS). Digest store after the real sessions: 6 files, 28 KB (no growth issue).

Lint budgets: SPAWN 30 s, CARGO 45 s, NPX 55 s, TSC 45 s, `HOOK_TIMEOUT_MS` 90 s, so hashing is about 0.1% of the chain. RSS is transient per hook process. Write payloads already carry the full content on stdin (F05), so the content is already in memory on that path. F18's 10 MiB cap bounds lint output, not file reads, and is irrelevant here.

### Re-measured

Re-measured 2026-11-10, Node v24.22.2, ext4, median of 5, scratch files, digests byte-identical between both methods. The figures above are the earlier measurement and are kept.

| Size   | Whole-file (current code) | Chunked (1 MiB `readSync` loop) |
| ------ | ------------------------- | ------------------------------- |
| 1 MB   | 1.2 ms                    | not measured                    |
| 10 MB  | 11.3 ms                   | 7.0 ms                          |
| 50 MB  | 61.8 ms                   | 31.0 ms                         |
| 200 MB | 271 ms                    | 125 ms                          |

maxRSS of a fresh node process (node floor about 50 MB): whole-file 60 MB for a 10 MB file and 250 MB for a 200 MB file (about 1.25x the file size); chunked flat at 51 MB for every size.

## Code locations

`fileDigest` (`createHash("sha256").update(readFileSync(fp)).digest("base64")`, no size check), `recordWritten` (every in-scope Write/Edit, before the lint; errors swallowed; temp file + `renameSync`), `fileChangedHandler` (digest compare; only when a stored digest exists; a stale digest is `rmSync`'d).

## Decision

Closed docs-only; hook behaviour is unchanged. The only measurable cost is milliseconds in a background hook, bounded by the lint it precedes; every code option either changes behaviour or adds code for a case with no observed instance.

### Alternatives considered

1. Size cap (e.g. 8 MB) skipping digest and FileChanged lint (the original approach of this doc). Rejected: a skipped lint is a policy change that drops findings for large source/generated files that are linted today (F19 user decision: generated files stay linted); the cap is a magic number with no observed trigger; it needs a user decision and saves only milliseconds.
2. Cap on digest only (`statSync`, skip the hash, write nothing above the cap). Rejected: with no digest, a Written-then-externally-changed big file hits `recorded === null` and falls to the git gate and the lint, i.e. a new duplicate lint of huge files, more expensive than the hash saved. Making it correct also needs `recordWritten` to `rmSync` a stale digest (symmetric with `fileChangedHandler`): more code and states than the problem warrants.
3. Chunked hashing (`openSync`/`readSync`/`createHash().update` loop). Digest-identical, bounds RSS to the node floor and is about 2x faster above 10 MB (7 vs 11 ms at 10 MB, 125 vs 271 ms at 200 MB; see Re-measured). Its only rejection reason: no observed instance; the saving is milliseconds under a 30-55 s lint that reads the same file anyway. It stays the named first option on reopen (deferred, not rejected).

## Verification

No code changed, so no new tests; the rebuilt `plugin/hooks/lint-file.mjs` is byte-identical; the existing suite (tests/file-detection.test.mts digest test "FileChanged: skipped while the content matches the Write/Edit digest, linted after a further change") stays green.

## Constraints

Must not skip normal-sized files. Fail open. The digest format (sha256 of the full file bytes, base64) must not change; otherwise existing digests in `written/` mismatch and cause one duplicate lint per file. Version bump.

## Reopen trigger

Reopen only on (a) a measured hook RSS or latency problem attributable to hashing a huge Written file, or (b) large generated/data files showing up in watch lists with measurable cost.

On reopen, chunked hashing first (digest-identical): the `node:fs` import gains `openSync`, `readSync`, `closeSync`; `fileDigest` opens the file, loops `readSync` into a 1 MiB buffer and calls `hash.update(buf.subarray(0, n))` until `n === 0`, then `closeSync` (in `finally`) and returns `hash.digest("base64")`, still sha256 base64. A lint size skip only as a user decision (F19 policy).

## Related

F05 (large payloads), F19 (generated files), F18 (output cap), F22/F23 (docs-only close precedents).
