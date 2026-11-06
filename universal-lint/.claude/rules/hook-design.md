---
paths:
  - "src/hooks/**"
  - "plugin/hooks/**"
  - "tests/{core,debounce,npx-fallback,rtk,truncation,manifest}.test.mts"
---

# Hook design (do not "fix" without reading this)

- **One async `command` hook:** PostToolUse `Write|Edit` → `"${CLAUDE_PLUGIN_ROOT}/hooks/lint-file.mjs"` (the placeholder is quoted so a plugin path with a space survives; `claude plugin validate` warns otherwise), `timeout: 95`, `async: true`, no `statusMessage` (silent).
  - Invoked directly, no `node` prefix: the built file has a node shebang and the exec bit the build sets. One process per Write/Edit, no persistent process.
  - `timeout: 95` = 90 s lint budget + 5 s debounce wait (see "Timeout budget").
- **Single-hook exception to the `mcp_tool`-preferred default** (kwitsch/claude-plugins prefers a persistent MCP stdio server for hooks, as `dprint` does here):
  - A persistent MCP stdio server buys nothing for exactly one hook.
  - `async: true` removes the one argument for a server (per-event spawn latency): the agentic loop doesn't wait either way.
  - Safe because linting never mutates the file: findings arriving a turn later cost no correctness. `universal-format` stays synchronous for the opposite reason.
  - Adding a second hook voids the exception.
- **No launcher script, no `.mcp.json`:** a direct `.mjs` command hook needs neither; the script always runs under `node`, never `bun`.

## Debounce (per-file idle window)

- Each hook process writes a unique token to a per-file marker under `tmpdir()/universal-lint-debounce/<sha256(resolved path)>.mark` (atomic: temp file + `renameSync`), sleeps `DEBOUNCE_MS`, re-reads the marker, and lints only if its token is still the newest.
  - A later edit overwrites the token, so older sleepers bail: N edits in the window → N sleeping processes, one linter run.
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

- Every guard failure, clean result, skip (crash/misconfig) or missing tool returns `{}` silently (fail open); only issues produce a truncated `additionalContext`. The guard chain lives in `resolveLintTarget`/`lintFileHandler`.
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

## Path exclusions (`isExcludedPath`)

- Skips `node_modules/`, `vendor/`, `.git/`, plus two Claude-Code-owned subtrees that can land inside a broad `cwd` (e.g. `$HOME`, or a repo root nesting worktrees): `.claude/worktrees/` (harness-created git worktrees, never this session's own content) and `.claude/agent-memory/` (gitignored agent runtime artifacts).
- Any basename containing `.local.` (e.g. `settings.local.json`) is skipped in any directory, matching `.claude/.gitignore`'s `*.local.*` personal-override convention.
- **Deliberately narrow — not a blanket `.claude/` exclusion.** Tracked content under `.claude/` (`rules/`, `agents/`, `skills/`, `settings.json`) must keep getting linted; a `.claude/rules/*.md` edit still triggers markdownlint.
