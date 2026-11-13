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
- Never-format invariants (outside the cwd, `node_modules`, `vendor`, `.git`, the session scratchpad, `*.local.*`) are enforced in one function and tested for every hook path.

## git

- Pass git the real path: git refuses a pathspec "beyond a symbolic link" and answers "not ignored" / "unchanged", silently skipping or formatting the wrong files.
- Use `--literal-pathspecs` (global option, before the subcommand): `[slug]`, `*`, `?` in a path are otherwise globs. `git status --porcelain -z --no-renames` for machine reading (toplevel-relative paths; an untracked directory is one entry ending in `/`; a changed submodule is one entry without it; `--ignore-submodules=none` against `submodule.<n>.ignore` settings).
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

## Slow file systems (9P, WSL `/mnt/c`)

- Measure before assuming: a stat costs 0.7-2.5 ms there (ext4: 5 us), `git status` 130-330 ms, `dprint file-paths` 11 s for 1500 files. Sample a few stats at run time and branch on the result; do not switch globally (git costs 68 ms on ext4 where the scan costs 14 ms).
- mtimes lag `Date.now()` by about 1.5 s: use a wide slack there, and treat extra candidates as harmless when a later check (digest, git index) filters them.
- Start long reads (first file listing) in the earlier hook (`PreToolUse`) so they overlap the tool call.
- Paths compare case-insensitively on such mounts (git keeps the cwd's casing, its index keeps another).
