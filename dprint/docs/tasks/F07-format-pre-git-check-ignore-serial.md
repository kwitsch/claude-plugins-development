---
id: F07
title: Overlap or drop the git check-ignore spawn in formatPre
status: open
priority: low
area: dprint/src/mcp/format.mts (formatPre, isGitIgnored)
---

# F07 Overlap or drop the git check-ignore spawn in formatPre

## Status

Open, deliberately not done: the analysis verdict is "not worth fixing". No code change in dprint 0.8.0; `formatPre` still awaits `isGitIgnored(fp)` before the dprint request. Do not spend a version bump on it alone.

## Problem

`formatPre` awaits one `git --no-optional-locks check-ignore -q -- <fp>` (~3-4 ms median; spawn floor 1.7 ms) strictly before the lsp request, also for files dprint would refuse anyway (config excludes, unknown extension: answered null in ~1 ms). For small files that is 50-65% of server-side time (Write no change, 50 lines: 5.0 -> 1.6 ms without it) but only 2-7% of a ~150 ms end-to-end Edit (plugin share ~40 ms, Claude Code dispatch ~15 ms per mcp_tool hook dominates).

## Evidence

Interleaved bench: removing the guard saves 3.0-3.3 ms per Write/Edit (in-process and via stdio). The proposed `Promise.all([isGitIgnored(fp), format])` saves only 1.1-1.7 ms (not the expected 3): ~2 ms of the spawn is the synchronous fork/exec in `execFile`, which blocks the loop, and only ~1.3-1.8 ms of async remainder overlaps; sending the dprint request before the spawn is no better. `Promise.all` also spawns a dprint lsp even when only ignored files are edited. Semantics: dprint lsp honours `.gitignore` and `.git/info/exclude` (also for not-yet-existing Write targets) but NOT `core.excludesFile`; only `git check-ignore` covers the latter.

## Code locations

- `formatPre` (`if (await isGitIgnored(fp)) return {};` after the `findConfig` gate)
- `isGitIgnored` (nearest existing ancestor as cwd; no git/no repo/timeout = not ignored)
- test: "file_changed leaves a file alone that is unchanged against the git index" also asserts gitignored Write/Edit are skipped; the stub dprint lsp does NOT honour .gitignore, so removing the guard breaks that test unless the stub learns it

## Approach

Recommended: leave as is. If ever changed, the options are (1) delete the guard (-3.3 ms; needs the user's acceptance that `core.excludesFile` patterns get formatted, plus a stub that honours `.gitignore`) or (2) `Promise.all` overlap (-1.1..-1.7 ms, below the 2 ms ship threshold, extra lsp spawn for ignored-only sessions). A cheaper variant, not benchmarked: cache the result per (directory, file) for a short time, only if repeated Edits of one file matter.

## Verification

If implemented: paired interleaved bench of `formatPre` on 50/500/3000-line files (N >= 40), plus `pnpm --filter dprint build && pnpm --filter dprint test`; the end-to-end gain must exceed ~2 ms server-side to justify a bump.

## Constraints

Edit `src/`, not `plugin/**/*.mjs`; zero-dep; fail open; TSDoc; version bump in both `dprint/plugin.json` and `dprint/package.json`. Gitignore behaviour is a user decision (gitignored files are never formatted); do not change it without asking.

## Related

F06 (fileChanged merged its two spawns; formatPre keeps check-ignore), F22/F27 (other per-call overhead, mostly Claude-side or 9P-specific).
