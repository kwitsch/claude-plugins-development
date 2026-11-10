---
id: F22
title: FileChanged skip without a git status spawn (index blob id)
status: done
priority: low
area: universal-lint/docs/tasks/F22-filechanged-skip-without-git.md, universal-lint/docs/TASKS.md
---

# F22 FileChanged skip without a git status spawn

## Status

Closed docs-only in 0.15.19. Measured during exploration on 2dfc11d against the committed plugin/ 0.15.18 (perf.mts, 3 runs + warm-up), spot-checked at spec approval (ext4 2 runs: 55/46-50/27 ms; 9P 1 run: 145-182/172-175/48 ms): the git gate costs about 5-9 ms (derived) of a ~52 ms skip on ext4 and ~130 ms of ~182 ms on 9P, background only (asyncRewake). A skip that fails toward linting needs a map that is rebuilt after every index rewrite, plus a long pitfall list. No code shipped. 0.15.19 because the root CLAUDE.md version rule applies to any change under `universal-lint/`.

## Problem

Each FileChanged event spawns node plus `git status` for one file to detect "tracked and unchanged". Branch switches, rebases, pulls and stashes produce one event per changed watched file, all at once.

## Evidence

Unchanged tracked file: ext4 41-51 ms, 50k-file index 61-100 ms, /mnt/c blocky-dev 202-340 ms (git status 139-180 ms). Transcripts: 576 git merge/rebase/pull/stash/reset and 186 checkout/switch/restore Bash calls, plus 847 builds and 389 `sed -i`, across 22,730 Bash calls.

### Re-measured

Measured during exploration on 2dfc11d against the committed plugin/ 0.15.18 (`node universal-lint/scripts/perf.mts`, 3 timed runs + 1 warm-up per row, direct timings 12-15 runs; nothing rebuilt, src/ untouched). Spot-checked at spec approval: ext4 2 runs 55/46-50/27 ms, 9P 1 run 145-182/172-175/48 ms. 9P = TMPDIR and fixture on /mnt/c. Fixture: 7 files.

| Case                                              | ext4 (n=3)                                | 9P (n=3)                   |
| ------------------------------------------------- | ----------------------------------------- | -------------------------- |
| FileChanged tracked unchanged                     | 52 ms (51-59)                             | 182 ms (182-183)           |
| FileChanged ignored                               | 55 ms                                     | 180 ms                     |
| FileChanged unlink                                | 49 ms                                     | 48 ms                      |
| empty payload `{}`                                | 50 ms (47-55)                             | 49 ms                      |
| node floor (`node -e 0`)                          | 26 ms                                     | 30 ms                      |
| git gate (derived: unchanged minus empty payload) | about 5-9 ms (derived; direct gap 5-7 ms) | about 130-135 ms (derived) |
| SessionStart fixture (watch list)                 | 55 ms                                     | 96 ms                      |

The 50k-file figure above (61-100 ms) was not re-measured. A bare `git status` timing was blocked by the session git guard, so both gate figures are derived by subtraction.

## Code locations

`fileChangedHandler` (`execFileSync("git", ["--no-optional-locks", "status", "--porcelain", "--untracked-files=normal", "--ignored=matching", "--", fp])`); `watchList`.

## Decision

Closed docs-only; the `git status` gate stays.

Why it does not pay:

1. ext4: replacing the gate saves about 5-9 ms per event at most. Reading the file, SHA-1 hashing it and loading the map costs about the same.
2. 9P: the saving is real, about 130 ms per event. But FileChanged runs with `asyncRewake: true` (plugin/hooks/hooks.json), so a skip never blocks the user, and there are no 9P sessions in the transcripts.
3. A correct skip needs the current index and HEAD. The index is rewritten once per git operation (index.lock then rename at its end), so a map keyed on index stat and HEAD would be stale after each operation. A lazily rebuilt map (the first post-rewrite FileChanged runs `git ls-files -s -z` plus `git diff --cached --name-only -z`, coalesced under an fc-locks-style `wx` lock) would serve the remaining events of a burst. It is not adopted because (a) events delivered before the index write fall through to git anyway, and the before/after split of a burst was not measured; (b) the rebuild is a full-index spawn on 9P and may run twice when the first event races index.lock; (c) ext4 does not pay, 9P is background-only with no 9P sessions, and the pitfall list below stays. Write/Edit rewrites are already covered by the digest store, and F15 found that builds which unlink and recreate files mostly drop their watches anyway.
4. Making it safe needs a per-cwd map store, parsing of the git-dir, HEAD, packed-refs and index stat (linked worktrees have a `.git` file), checks for filters, attributes and config, and handling of mode, stage, objectFormat and intent-to-add. The lock adds its own residuals (stale reclaim, shared data dir, pid namespaces, as F10/F13). That is large code for a background saving on a filesystem nobody uses in the transcripts.

### Alternatives considered

- B. The literal approach filed here (`git ls-files -s -z` in `watchList`, path to blob id, in-process `sha1("blob <len>\0" + bytes)` at FileChanged, skip when equal). Rejected: unsafe, it violates the fail-toward-lint constraint. The filed constraint that a mismatch only costs a git spawn is wrong; the failure is the other direction (a match skips a file git reports as changed). Pitfalls:
  - Stale map: SessionStart stores blob X, later the index moves to Y (`git add`, reset, merge) and the worktree goes back to the X bytes. The hash matches and the hook skips, while `git status` reports a change and today's gate lints.
  - Staged-only change: index == worktree != HEAD. `git status --porcelain` prints `M `, so today it lints, but the index blob matches and B would skip.
  - Mode-only change (chmod): git reports it, content equality skips it.
  - Intent-to-add (`git add -N`): the index holds the empty blob e69de29b..., so an empty worktree file matches.
  - Unmerged entries (stage 1-3), symlinks (mode 120000), and `extensions.objectFormat=sha256` repos (64-hex ids).
  - Filters (autocrlf, eol, text, ident, clean/smudge): a raw-byte match with a non-idempotent clean filter can skip a file git reports as modified.
- C. Safe index map, `/mnt/` only, lazily rebuilt. B plus: the map is keyed per cwd under `${CLAUDE_PLUGIN_DATA || tmpdir()}/index/<hashPath(cwd)>` and records the git index stat (ino, size, mtimeMs) and the resolved HEAD commit at build time. Only stage-0 entries with mode 100644 or 100755 go in, excluding the empty-blob intent-to-add id and anything that differs from HEAD (`git diff --cached --name-only -z`). Lookup fails back to git on any index or HEAD change, any filter or eol attribute, `core.autocrlf`, a non-SHA-1 format, or any error. The rebuild is lazy (first FileChanged after an index change, under an fc-locks-style `wx` lock). New code only runs for `/mnt/` paths (the prefix check F20 uses). This is the strongest alternative and the reopen trigger points to it. Not adopted for the reasons in Decision item 3 and 4.
- D. In-process `.git/index` reader (DIRC v2/v3/v4, prefix compression, extensions) compared against the HEAD tree (zlib plus pack and delta resolution). Removes staleness but reimplements git in zero-dependency Node. Rejected outright.

## Verification

No code changed, so no new tests. The measurements above were taken with `node universal-lint/scripts/perf.mts` against the committed plugin/ 0.15.18 (TMPDIR and fixture on /mnt/c for the 9P column). The existing suite (`tests/file-detection.test.mts` FileChanged and watch-list tests, `tests/manifest.test.mts` wiring) stays green against the rebuilt plugin/, whose `.mjs` files are byte-identical.

## Constraints

Any reopened design must fail toward linting: a stale map can skip a changed file (map blob matches the worktree while the index or HEAD moved), so it has to invalidate on index stat and HEAD change, and fall back to `git status` on any filter, eol, mode, stage, symlink, objectFormat or intent-to-add doubt. Version bump.

## Reopen trigger

Reopen when FileChanged skip-path events on 9P or repos of 50k+ files become a measurable share of real sessions (transcripts), or on a user report of FileChanged load during checkout bursts on /mnt/.

Design pointer: alternative C plus lazy rebuild under an fc-locks-style lock, `/mnt/` prefix only. First measurement to make: how many of a burst's FileChanged events arrive after the `.git/index` write (F15 harness, index mtime vs payload times).

## Related

F10, F12, F13 (lock pattern), F15 (watch drop on unlink+create), F20 (`/mnt/` prefix check), F01 (skip-path baseline), dprint F06.
