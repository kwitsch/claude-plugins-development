---
id: F25
title: Bound digest hashing and FileChanged lint by file size
status: open
priority: low
area: universal-lint/src/hooks/lint-file.mts (fileDigest, recordWritten, fileChangedHandler)
---

# F25 Bound digest hashing and FileChanged lint by file size

## Status

Open, optional. watch-filechanged finding (confirmed, low; edge case).

## Problem

`fileDigest` reads the whole file into memory and hashes it with no size cap, for every in-scope Write/Edit and every FileChanged with a stored digest; huge files then go on to a lint of dubious value.

## Evidence

sha256(readFileSync), median of 5: 1 MB 1.3 ms; 10 MB 11.7 ms (115 MB RSS); 50 MB 60-63 ms (199-200 MB RSS); 200 MB 244 ms (450 MB RSS). Digest store after the real sessions: 6 files, 28 KB (no growth issue).

## Code locations

`fileDigest`, `recordWritten`, `fileChangedHandler` (digest compare).

## Approach

`statSync` first; above a cap (e.g. 8 MB) skip digest and FileChanged lint, or stream the hash in `readSync` chunks to bound RSS. Only together with a FileChanged size guard if large generated or data files show up in watch lists.

## Verification

Unit test: a 20 MB .yml FileChanged returns `{}` without spawning the stub linter; `recordWritten` on it writes nothing.

## Constraints

Must not skip normal-sized files. Fail open. Version bump.

## Related

F05 (large payloads), F19 (generated files).
