---
paths:
  - "src/hooks/**"
  - "plugin/hooks/**"
  - "tests/{core,debounce,npx-fallback,rtk,truncation,manifest,registry,tsc}.test.mts"
---

# Hook design (do not "fix" without reading this)

- **One `asyncRewake` `command` hook:** PostToolUse `Write|Edit` → `"${CLAUDE_PLUGIN_ROOT}/hooks/lint-file.mjs"` (the placeholder is quoted so a plugin path with a space survives; `claude plugin validate` warns otherwise), `timeout: 95`, `asyncRewake: true` (not `async`), no `statusMessage` (silent).
  - `asyncRewake` runs the hook in the background like `async`, but exit `2` wakes Claude with stderr as soon as the lint finishes, instead of the findings waiting for the next turn. Contract (same as the repo's `.claude/hooks/oxlint-edited.sh`): findings = the `universal-lint: …` text on stderr + exit `2`; nothing to report = no output, exit `0`.
  - Invoked directly, no `node` prefix: the built file has a node shebang and the exec bit the build sets. One process per Write/Edit, no persistent process.
  - `timeout: 95` = 90 s lint budget + 5 s debounce wait (see "Timeout budget").
- **Single-hook exception to the `mcp_tool`-preferred default** (kwitsch/claude-plugins prefers a persistent MCP stdio server for hooks, as `dprint` does here):
  - A persistent MCP stdio server buys nothing for exactly one hook.
  - Running in the background removes the one argument for a server (per-event spawn latency): the agentic loop doesn't wait either way.
  - Safe because linting never mutates the file: findings arriving after the edit (rewake) cost no correctness. `universal-format` stays synchronous for the opposite reason.
  - Adding a second hook voids the exception.
- **No launcher script, no `.mcp.json`:** a direct `.mjs` command hook needs neither; the script always runs under `node`, never `bun`.

## Debounce (per-file idle window)

- Each hook process writes a unique token to a per-file marker under `tmpdir()/universal-lint-debounce/<sha256(resolved path)>.mark` (atomic: temp file + `renameSync`), sleeps `DEBOUNCE_MS`, re-reads the marker, and lints only if its token is still the newest.
  - A later edit overwrites the token, so older sleepers bail: N edits in the window → N sleeping processes, one linter run.
- **Coalesced edits (`<hash>.edits`):** after the marker rename each process appends one line `JSON.stringify([Date.now(), editEntry(input)])` to `tmpdir()/universal-lint-debounce/<hash>.edits` (same `hashPath(resolved)` key as the marker). The winner renames the file to `<hash>.edits.<token>`, reads it, removes it, and gates against the union of all entries (`lintFileHandler(input, edits)`); its own entry is always included. Appends after the rename start a fresh file for the next winner.
  - Entries older than `EDITS_MAX_AGE_MS` (10 min) are ignored: they come from a hook killed during its sleep and would otherwise widen a later run's range indefinitely.
  - **Accepted residual:** an append opened just before the winner's rename whose write lands after the winner's read is lost with the renamed file (microsecond window). Every other ordering is safe.
  - Every edits-file op (append, rename, read, parse, remove) fails open to the process's own entry; it never skips a lint. The extra I/O is microseconds and is not a term of the timeout budget.
- `UNIVERSAL_LINT_DEBOUNCE_MS` overrides the window — a test-only fast path (the vitest harness `tests/support/lint-hook.mts` runs at `0`); NOT a `userConfig`, not part of the hook input contract. An explicitly empty value falls back to the real 5000 ms default (tested).
- Markers live in `tmpdir()`, not `${CLAUDE_PLUGIN_DATA}` (unlike `tsBuildInfoPathFor`): ephemeral signalling files with no cross-update persistence need. No cleanup routine — tiny, the OS reclaims `tmpdir()`.
- Every debounce filesystem op fails open: the lint runs on error, never silently skipped.
- **Accepted residual:** a lint already past the gate can't be cancelled, so two edits spaced further apart than the window with a lint slower than the gap can still overlap. Only a persistent server could cancel in-flight lints (the rejected design). The overlap also keeps the `--tsBuildInfoFile` race possible, but rare.

## Timeout budget (re-derive when `hooks.json` `timeout` or any `*_TIMEOUT_MS` changes)

- Lint phases run **sequentially**: the language's chain tool, then (`.ts`/`.tsx`/`.mts`/`.cts` only) `tsc`. Per-phase budgets are the `*_SPAWN_TIMEOUT_MS` constants in `src/hooks/lint-file.mts`; the hook-level `timeout` is only the backstop that kills the whole process.
- `tsc`'s budget is below the npx one (a stale async finding arrives too late to be useful) and above the single-file one (a whole-project check is slower).
- Nominal worst case, TS file: chain 30 s + `tsc` 45 s = 75 s → 15 s margin inside the 90 s lint budget.
- **rtk-then-direct doubling:** `runLintTool`'s on-`PATH` branch tries `rtk` first; if that attempt times out it spawns the tool again at the same timeout. A phase can therefore cost 2× nominal (chain 60 s, on-`PATH` `tsc` 90 s). Pre-existing, applies to every chain tool, reworking it is out of scope. `manifestPath` (cargo) tools skip `rtk` — no doubling.
- **Cold npx:** the rtk-wrapped attempt is bounded by `RTK_NPX_ATTEMPT_TIMEOUT_MS` (5 s), then bare npx gets `NPX_SPAWN_TIMEOUT_MS` (55 s) → 60 s worst case, the same as the direct branch's doubling. Giving both the full npx budget would total 110 s > 90 s — the reason for the separate bound; don't unify them.
- **Accepted:** when combined wall time exceeds the 90 s lint budget (cold npx 60 s + `tsc` 45 s = 105 s, rtk doubling, or both compounding) the hook is killed and that turn's async findings are silently lost. Fail-open, never a wrong result; the next edit's `tsc` hits a warm cache.

## Runtime behavior (`lint_file`)

- Every guard failure, clean result, skip (crash/misconfig) or missing tool returns `{}` silently (fail open); only issues produce a truncated findings text (`lintFileHandler` returns it as `additionalContext`; `main` writes it to stderr and exits 2). The guard chain lives in `resolveLintTarget`/`lintFileHandler`.
- First chain tool on `PATH` wins; there is no per-file style-conflict skip (a linter needn't reproduce exact output the way a formatter does).
- Go entries target the edited file's **directory** (`go vet`/`golangci-lint` are package-scoped); checkstyle gets `-c <resolved config>`.
- stdout+stderr are captured and **never ignored**, unlike the formatter sibling: the findings text IS the payload. `maxBuffer` is raised well above the 1 MB default for the same reason — a noisy linter's output would otherwise truncate as ENOBUFS.
- Success is **classification, not a content diff** (the file is never modified): `classifyExit` applies each tool's documented exit-code contract.
- **Exception: `checkstyle`** is classified by output (`classifyCheckstyleOutput`): its exit code counts only `error`-severity violations, and the bundled default ruleset (and many real projects) run at `warning` — exit-code classification would silently miss real findings.
- `stylelint` (CSS/SCSS) does not share the 0-clean/1-issues contract: `0` clean, `2` real lint problem, anything else (`1` fatal, `64` bad usage, `78` bad config) skip (stylelint.io CLI docs).
- `yamllint` runs without `--strict`, so warnings-only findings don't surface — consistent with `eslint` (warnings don't affect its exit code either).

### npx fallback

- `eslint`, `oxlint`, `markdownlint-cli2`, `markdownlint` and `stylelint` fall back to `npx --yes <package> ...` when absent from `PATH` (npm package name = bin name, so the single-positional idiom is safe; `npx` is assumed present since the hook already runs under node).
- `yamllint` has no npm package (PyPI only); `ruff`, `golangci-lint`, `go`, `ktlint`, `checkstyle` and the Rust/PHP tools have no safe npm equivalent either.

### rtk compaction

- Tool on `PATH` **and** `rtk` on `PATH` → run through `rtk` for token-compacted findings. `rtk` passes the wrapped tool's exit code through unchanged (verified for `ruff`, `eslint`), so the classifiers need no awareness of it.
- Which tools `rtk` has a filter for is discovered per hook process via `rtk rewrite <tool> <static args> "__RTK_PROBE__"` (cached per tool), not hardcoded — filters come and go across `rtk` releases (`checkstyle`, `ktlint` currently have none and run directly).
  - The probe keys off non-empty stdout, not the exit code (`rtk rewrite --help` claims 0/1; observed 3/1 on 0.43.0).
- Both rtk attempts share `tryRtk`: a spawn error or signal is a failure (fall back to the un-accelerated call, so a broken `rtk` can't disable linting).
  - A clean non-zero exit is an `rtk`-internal failure only when stdout is empty/whitespace — real findings always make stdout non-empty, while `rtk` failing to reach its backend/`npx` would otherwise show up as a fake lint finding.
- **npx-fallback branch** (tool absent from `PATH`, npm-distributed): try `rtk`'s own verb first (`rtk lint <argv>` for `eslint`), **never** `rtk npx --yes <pkg>`.
  - `--yes`/`-y` defeats `rtk`'s npx package-name detection, so the wrapped call yields byte-identical unfiltered output; `rtk lint` compacts and resolves `eslint` itself even when it's absent from `PATH`.
  - `rtk markdownlint` is an unfiltered passthrough needing the literal binary: with it missing the attempt fails (empty stdout, non-zero), `tryRtk` reports failure, and the code falls through to bare `npx --yes`. `markdownlint-cli2` has no `rtk` verb and always falls through.
- `manifestPath` (cargo) tools never go through `rtk` (see `languages.md`, "Rust").

## Edit-range gate

- After an `Edit` the hook exits 2 only when a diagnostic is not proven to sit in the edited file outside the edited lines. No registered tool (shellcheck, checkstyle, ktlint, eslint, oxlint, ruff check, golangci-lint, go vet, yamllint, markdownlint(-cli2), stylelint, phpstan, psalm, cargo clippy/check) nor `tsc` has a line-range check mode (`golangci-lint --new-from-rev`/`psalm --diff` are git-based; `ruff format --line-range` is not a check), so the scan stays file/project-scoped and `gateFinding` filters the raw text afterwards. `buildArgv`/`classifyExit`/rtk are unchanged.
- **Range source:** every non-overlapping occurrence of `tool_input.new_string` in the post-edit file (`editRanges`, inclusive 0-based lines; a trailing `\n` does not spill into the next line), for every entry of the debounce window (see "Debounce"). All occurrences count (over-inclusion only keeps more).
- **Whole file:** `Write`, any non-`Edit` tool, a missing `new_string`, or a non-empty `new_string` no longer found on disk. **Pure deletion** (empty `new_string`): no edited lines; a window of only deletions returns `{}` without linting.
- **Location extraction**, per line after stripping `ANSI_SGR_RE`; first match wins:
  - A `LOC_PATH_RE` `<path>.<ext>[:(]<line>`: ruff, ktlint, golangci-lint, go vet, checkstyle `[WARN] /abs/A.java:3:`, markdownlint `a.md:12`, psalm, oxlint `,-[src/a.ts:3:7]`, cargo `--> src/a.rs:12:5`, tsc `a.ts(12,5)`/`a.ts:12:5`.
  - B `LOC_ROW_RE` `  <line>:<col>  ` rows (path-less, own file): eslint stylish, stylelint stylish, yamllint standard.
  - C `LOC_SHELLCHECK_RE` `In <file> line <n>:` (path-less, own file): shellcheck's default tty format.
- **Base directory** (`Finding.base`, set in `runChainLint`/`runTypeCheck`): cargo → directory of the `--manifest-path` Cargo.toml; golangci-lint/go vet (`targetsDir`) → the edited file's directory; tsc and every other tool → the payload `cwd` (their spawn cwd).
- **Path matching (user decision):** (1) `path.resolve(base, p) === resolved` → own file; (2) else, only for a relative `p` whose base-resolved path does not exist, a path-segment suffix match (`resolved.endsWith(sep + p)`) → own file (covers cargo workspace-root paths, cwd-relative go paths, a path split by a space); (3) else **foreign**: kept and reportable. Diagnostics in other files (e.g. tsc errors elsewhere) therefore still exit 2.
- **Filtering** by blank-line paragraphs: a paragraph without a located line is kept but not reportable (headers, summaries, rtk notes); otherwise it is split into segments at located lines (each carries the unlocated lines after it, so tsc continuation lines stay with their diagnostic; earlier lines are the preamble). Own-file misses are dropped, hits and foreign segments kept; a paragraph whose segments are all dropped loses its preamble. Exact lines, no context slack.
- **Result:** no located line at all → finding unchanged (fail open = report: rtk-compacted text, phpstan's table format); nothing reportable left → finding dropped; exit 2 only when at least one finding survives. The gate runs before `truncate()`.
- **Residuals:** a pure deletion is never reported; a later edit rewriting an earlier `new_string` widens that run to the whole file; a same-named file reached only by the suffix fallback can be mistaken for the edited file; a format the regexes miss is reported unchanged.

## Path exclusions (`isExcludedPath`)

- Skips `node_modules/`, `vendor/`, `.git/`, plus two Claude-Code-owned subtrees that can land inside a broad `cwd` (e.g. `$HOME`, or a repo root nesting worktrees): `.claude/worktrees/` (harness-created git worktrees, never this session's own content) and `.claude/agent-memory/` (gitignored agent runtime artifacts).
- Any basename containing `.local.` (e.g. `settings.local.json`) is skipped in any directory, matching `.claude/.gitignore`'s `*.local.*` personal-override convention.
- **Deliberately narrow — not a blanket `.claude/` exclusion.** Tracked content under `.claude/` (`rules/`, `agents/`, `skills/`, `settings.json`) must keep getting linted; a `.claude/rules/*.md` edit still triggers markdownlint.
