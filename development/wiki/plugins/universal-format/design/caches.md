# Config and ignore caches (do not "fix" back to a per-format refresh)

Which state the server keeps between formats, when it is refreshed, and what is deliberately not noticed.

## prettier's config cache

- `formatInProcess` does not call `clearConfigCache()`. Per format it cost nearly all of the time: 10.60 ms against 0.73 ms per format on a nested project (measured before 0.19.0, former repository).
- prettier's cache goes stale in three shapes: a config created after a negative lookup (prettier caches that too), an edited `.prettierrc`, an edited `.editorconfig` (a separate cache inside prettier; one `clearConfigCache()` covers both, checked in the former repository).
- The hook runs before a Write/Edit lands, and clearing right then would cache the old content again on the next `resolveConfig`. So `formatPre` records a pending refresh (`pendingRefreshes`, keyed by the resolved path) when the target's base name is in `CACHE_INVALIDATING_BASENAMES` (prettier's config names, `package.json`, `package.yaml`, `.editorconfig`, `.prettierignore`), with the file's stamp at that moment (inode, size, mtime; `""` when absent).
- Every `formatPre` call starts by checking the pending entries: one whose stamp changed (the write landed, from this agent or another) is dropped, `clearPrettierConfigCaches()` runs, and for a `.prettierignore` the ignore state of its own directory is re-read.
- What this depends on:
  - the note is taken before the language guard: most of these names have no extension and the guard would drop them;
  - the stamp decides, not a one-shot flag: a concurrent subagent's format between the hook and the write must not use the refresh up early;
  - an entry whose write never lands (a failed tool call) stays, at one `statSync` per format.
- Accepted, tested in both directions: a config changed without passing through Write/Edit (a Bash `sed`, an external editor) is not picked up until the server restarts. The tests probe `semi` on a `.mjs` file, never a JSON/YAML `printWidth`, which the printWidth guard re-reads from disk on every call.

## The ignore cache

- `isPrettierIgnored` is backed by `ignoreCache: Map<base, { hasRules, verdicts }>`, keyed by the base directory like `projectConfigCache`. A file outside the cwd adds one entry per foreign project root for the life of the process (accepted growth, the same class as the other caches).
- `hasRules` comes from the content of `<base>/.prettierignore`, not its existence: a file holding only blank and `#` lines cannot ignore anything. Any doubt (an unreadable file) counts as "has rules", the slow path through prettier.
- `verdicts` memoises prettier's own answers per path. Sound, because gitignore-style matching is purely path-based: an answer changes only when the ignore file does.
- Refreshed by a landed `.prettierignore` write only (`primePrettierIgnoreCache(dir)` re-reads the state of the ignore file's own directory, the only base it governs, whatever the base of the write was) and by a server restart. There is no start moment with a known cwd (MCP `initialize` carries none), so the cache fills on first use.
- `clearPrettierConfigCaches()` deliberately leaves `ignoreCache` alone: a `.prettierrc` write cannot change what is ignored.
- Same accepted limit, tested twice: an ignore file edited out of band is not picked up until a Write/Edit lands on it or the server restarts (mild: a newly ignored file is formatted once more).

## Other process-lifetime state

- `gitRootCache` ([scope-and-base.md](scope-and-base.md)), the PATH answer per CLI tool ([cli-formatters.md](cli-formatters.md)). The dprint gate caches nothing ([dprint-gate.md](dprint-gate.md)).
- Never a single "current cwd": concurrent calls of subagents carry different cwds against the one server process.
