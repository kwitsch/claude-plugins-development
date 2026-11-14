---
paths:
  - "*/src/**"
  - "*/tests/**"
---

# Rule: plugin code that reads or writes the user's files from hooks

Learned in the dprint plugin (0.12 to 0.13, a long bug hunt). Every point below was a real, reproduced defect.

## Scope and paths

- Decide scope on the **real path** (`realpathSync.native`; for a missing file, its nearest existing ancestor). Keep both forms (`fp` as written, `real`) and say which one each use needs: reads and writes go through `fp`, identity keys (digests, caches, git) use `real`.
- **Re-check right before the write**, not only at the start: a slot wait or a slow formatter (up to 30 s) is a window in which the file, or a directory above it, can become a symlink. `if (realish(fp) !== real) return` just before `writeFileSync`.
- A list cached once per cwd (watch list, prefetch) holds stale real paths: scope every file again (`inScope`) before touching it, and apply the **current** call's exclusions (scratchpad, cwd) instead of those of the call that filled the cache. A hook call that builds shared state must carry the same fields (`cwd`, `scratchpad_dir`, ...) as the calls that use it.
- A symlinked session cwd keeps its symlink in the payload `cwd`, Glob results and `$PWD`, but `process.cwd()` and every spawned child see the real path, and a tool that searches configs upward from its cwd climbs the real parents. Pick one spelling per comparison (universal-lint: a real-path root rejected every Glob path as outside it).
- Never-format invariants (outside the cwd, `node_modules`, `vendor`, `.git`, the session scratchpad, `*.local.*`) are enforced in one function and tested for every hook path.

## git

- Pass git the real path: git refuses a pathspec "beyond a symbolic link" and answers "not ignored" / "unchanged", silently skipping or formatting the wrong files.
- Use `--literal-pathspecs` (global option, before the subcommand): `[slug]`, `*`, `?` in a path are otherwise globs. `git status --porcelain -z --no-renames` for machine reading (toplevel-relative paths; an untracked directory is one entry ending in `/`; a changed submodule is one entry without it; `--ignore-submodules=none` against `submodule.<n>.ignore` settings).
- git prints non-ASCII names as quoted octal escapes (`core.quotePath`): read with `-z` or `-c core.quotePath=false`. git paths are toplevel-relative, not cwd-relative.
- Every git/dprint spawn has a timeout and fails open; a hanging git must not block the hook.

## File content

- Keep what you did not mean to change: a BOM (`TextDecoder` drops it unless `ignoreBOM: true`; digests must be computed on the same text on both sides), the file's line endings (a single stray CRLF in an LF file must not turn the whole file CRLF: skip mixed endings), the file mode (in-place write).
- Size cap before any spawn (`overCap`), checked with `statSync` before the read so the file never enters the heap.
- Quote file names that go into text for the model (`JSON.stringify`): a name can hold newlines or instruction-like text. Print names relative to the **real** root.

## Caches, timers, state

- Every `Map` has a bound or a TTL; a cache keyed by something coarser than its inputs (root only) is a bug source.
- Cache only exact hits when staleness cannot be detected cheaply (a config found in an ancestor hides a nearer one created later).
- A failed or empty read is retried after a delay (failure: short, empty: longer), never cached forever; concurrent callers share one promise.
- `dispose()` (may respawn: idle exit, timeout) and `close()` (retired for good: eviction, shutdown) are different; check `closed` again after every `await` that precedes a spawn.
- A start/finish hook pair is keyed by `tool_use_id`; entries of calls that never finish are pruned by age (longer than any call runs).

## Write/Edit content and concurrent hook processes

Learned in the universal-lint bug hunt (settle window). Each point was a reproduced lost or false finding.

- Take what a Write/Edit wrote from the payload (Write: `tool_input.content`; Edit: `tool_response.originalFile` with `structuredPatch` applied), never from the disk at hook time: another program can change the file between the tool and the hook, and a digest of the disk folds that change into the edit.
- Hook processes of consecutive edits run in parallel, so state they write lands in hook order, not edit order. A record that only makes sense relative to an earlier state (diff hunks) stores the digest of the content it applies to and is chain-checked against its predecessor; a broken chain means "cannot tell" and fails open.
- Equal digests before and after a long step do not prove nothing happened (an edit and its exact undo): also compare a generation marker, such as the newest record name.
- `CLAUDE_PLUGIN_DATA` is shared by every session of the plugin: a stamp that means "already reported" is keyed by `session_id` (a report reaches only its own session); a lock that serialises work may stay shared.
- Cleanup of stale state (`rmSync` of an old record) sits inside its own try/catch: a store documented to fail open must not throw from its cleanup and drop the real work.

## Slow file systems (9P, WSL `/mnt/c`)

- Measure before assuming: a stat costs 0.7-2.5 ms there (ext4: 5 us), `git status` 130-330 ms, `dprint file-paths` 11 s for 1500 files. Sample a few stats at run time and branch on the result; do not switch globally (git costs 68 ms on ext4 where the scan costs 14 ms).
- mtimes lag `Date.now()` by about 1.5 s: use a wide slack there, and treat extra candidates as harmless when a later check (digest, git index) filters them.
- Start long reads (first file listing) in the earlier hook (`PreToolUse`) so they overlap the tool call.
- Paths compare case-insensitively on such mounts (git keeps the cwd's casing, its index keeps another).
