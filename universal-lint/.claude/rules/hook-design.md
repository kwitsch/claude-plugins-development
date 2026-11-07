---
paths:
  - "src/hooks/**"
  - "plugin/hooks/**"
  - "tests/{core,npx-fallback,truncation,manifest,registry,tsc}.test.mts"
  - "tests/file-detection.test.mts"
---

# Hook design (do not "fix" without reading this)

- **Four `command` hooks, one entry:** every event runs `"${CLAUDE_PLUGIN_ROOT}/hooks/lint-file.mjs"` (the placeholder is quoted so a plugin path with a space survives; `claude plugin validate` warns otherwise); `main()` dispatches on `hook_event_name`. No `async`, no `statusMessage` (silent), no matcher on the three non-tool events.
  - PostToolUse `Write|Edit` (`PostToolUse[0]`, index pinned by `tests/manifest.test.mts`): `timeout: 90`, `asyncRewake: true`. Records the content digest (see "File detection"), then lints. A payload without `hook_event_name` is treated as PostToolUse.
  - SessionStart and CwdChanged: `timeout: 30`. Print the watch list on stdout as `{"hookSpecificOutput":{"hookEventName":<event>,"watchPaths":[…]}}`, only when it is non-empty; always exit `0`. CwdChanged builds the list for `new_cwd`; empty output leaves Claude Code with an empty watch list.
  - FileChanged: `timeout: 90`, `asyncRewake: true`. Lints a watched file changed outside Write/Edit with the same findings contract; the text is prefixed `universal-lint (changed outside Write/Edit): ` and `hookEventName` is `FileChanged`.
  - `asyncRewake` runs the hook in the background like `async`, but exit `2` wakes Claude with stderr as soon as the lint finishes, instead of the findings waiting for the next turn. Contract: findings = the `universal-lint…: …` text on stderr + exit `2`; nothing to report = no output, exit `0`.
  - Invoked directly, no `node` prefix: the built file has a node shebang and the exec bit the build sets. One process per event, no persistent process.
  - No debounce: every Write/Edit lints right away in its own process (user decision 2026-11-06, removed together with the edit coalescing it required).
- **Command hooks, no MCP server (user decision 2026-11-06)** (kwitsch/claude-plugins prefers a persistent MCP stdio server for hooks, as `dprint` does here):
  - Background lints (`asyncRewake`) remove the one argument for a server (per-event spawn latency): the agentic loop doesn't wait either way. The watch-list hooks are short `git ls-files` calls.
  - Safe because linting never mutates the file: findings arriving after the edit (rewake) cost no correctness. `universal-format` stays synchronous for the opposite reason.
  - Cost: no in-process state. The Write/Edit → FileChanged digest goes through disk (`CLAUDE_PLUGIN_DATA/written/`), and there is no cross-process concurrency cap on parallel FileChanged lints (accepted; `shortcut:` comment on `fileChangedHandler`).
- **No launcher script, no `.mcp.json`:** a direct `.mjs` command hook needs neither; the script always runs under `node`, never `bun`.

## Timeout budget (re-derive when `hooks.json` `timeout` or any `*_TIMEOUT_MS` changes)

- Lint phases run **sequentially**: the language's chain tool, then (`.ts`/`.tsx`/`.mts`/`.cts` only) `tsc`. Per-phase budgets are the `*_SPAWN_TIMEOUT_MS` constants in `src/hooks/lint-file.mts`; the hook-level `timeout` is only the backstop that kills the whole process.
- `tsc`'s budget is below the npx one (a stale async finding arrives too late to be useful) and above the single-file one (a whole-project check is slower).
- Nominal worst case, TS file: chain 30 s + `tsc` 45 s = 75 s → 15 s margin inside the 90 s lint budget.
- **Cold npx:** the single bare `npx --yes` attempt gets `NPX_SPAWN_TIMEOUT_MS` (55 s), the npx-fallback branch's worst case.
- Overlapping lints of quick successive edits share the `--tsBuildInfoFile` (accepted, see `typescript-check.md`).
- **Accepted:** when combined wall time exceeds the 90 s lint budget (cold npx 55 s + `tsc` 45 s = 100 s) the hook is killed and that turn's async findings are silently lost. Fail-open, never a wrong result; the next edit's `tsc` hits a warm cache.
- **git:** each git call (`git ls-files` for the watch list, `git status` for the FileChanged gate) is capped at `GIT_TIMEOUT_MS` (10 s). FileChanged nominal worst case: git 10 s + chain 30 s + `tsc` 45 s = 85 s < 90 s; the cold-npx overrun above applies unchanged (a kill loses that lint silently). SessionStart/CwdChanged: git 10 s plus one realpath per listed file, inside the 30 s hook timeout.

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

## Edit-range gate

- After an `Edit` the hook exits 2 only when a diagnostic is not proven to sit in the edited file outside the edited lines. No registered tool (shellcheck, checkstyle, ktlint, eslint, oxlint, ruff check, golangci-lint, go vet, yamllint, markdownlint(-cli2), stylelint, phpstan, psalm, cargo clippy/check) nor `tsc` has a line-range check mode (`golangci-lint --new-from-rev`/`psalm --diff` are git-based; `ruff format --line-range` is not a check), so the scan stays file/project-scoped and `gateFinding` filters the raw text afterwards. `buildArgv`/`classifyExit` are unchanged.
- **Range source:** the Edit `tool_response.structuredPatch` hunks (`editRanges`, inclusive 0-based lines): each run of `+` lines; a run of only `-` lines (pure deletion) gives the two lines around the deletion point, so deletions are linted too. `\ No newline at end of file` is not a line.
- **Whole file:** `Write`, any non-`Edit` tool, or a missing/malformed `structuredPatch`. An empty patch (nothing changed) returns `{}` without linting.
- **Location extraction**, per line after stripping `ANSI_SGR_RE`; first match wins:
  - A `LOC_PATH_RE` `<path>.<ext>[:(]<line>`: ruff, ktlint, golangci-lint, go vet, checkstyle `[WARN] /abs/A.java:3:`, markdownlint `a.md:12`, psalm, oxlint `,-[src/a.ts:3:7]`, cargo `--> src/a.rs:12:5`, tsc `a.ts(12,5)`/`a.ts:12:5`.
  - B `LOC_ROW_RE` `  <line>:<col>  ` rows (path-less, own file): eslint stylish, stylelint stylish, yamllint standard.
  - C `LOC_SHELLCHECK_RE` `In <file> line <n>:` (path-less, own file): shellcheck's default tty format.
- **Base directory** (`Finding.base`, set in `runChainLint`/`runTypeCheck`): cargo → directory of the `--manifest-path` Cargo.toml; golangci-lint/go vet (`targetsDir`) → the edited file's directory; tsc and every other tool → the payload `cwd` (their spawn cwd).
- **Path matching (user decision):** (1) `path.resolve(base, p) === resolved` → own file; (2) else, only for a relative `p` whose base-resolved path does not exist, a path-segment suffix match (`resolved.endsWith(sep + p)`) → own file (covers cargo workspace-root paths, cwd-relative go paths); (3) else **foreign**: kept and reportable. Diagnostics in other files (e.g. tsc errors elsewhere) therefore still exit 2.
- **Filtering** by blank-line paragraphs: a paragraph without a located line is kept but not reportable (headers, summaries); otherwise it is split into segments at located lines (each carries the unlocated lines after it, so tsc continuation lines stay with their diagnostic; earlier lines are the preamble). Own-file misses are dropped, hits and foreign segments kept; a paragraph whose segments are all dropped loses its preamble. Exact lines, no context slack.
- **Result:** no located line at all → finding unchanged (fail open = report: phpstan's table format); nothing reportable left → finding dropped; exit 2 only when at least one finding survives. The gate runs before `truncate()`.
- **Parse errors are always kept:** an own-file miss whose segment or paragraph preamble matches `PARSE_ERROR_RE` (parse/syntax error wording, `unclosed`, `unterminated`, `end of file`, tsc `TS1xxx`, shellcheck `SC1xxx`) stays reportable, since an edit-caused parse error is often reported away from the edit (unclosed brace → EOF). Other own-file diagnostics outside the edit (e.g. a tsc call-site error in the same file) are dropped by design.
- **Residuals:** a parse error phrased outside `PARSE_ERROR_RE` is gated; a path containing a space is not matched and counts as foreign (kept); a same-named file reached only by the suffix fallback can be mistaken for the edited file; a format the regexes miss is reported unchanged.

## File detection (FileChanged + watch list)

- **Scope (`scopedTarget`, port of dprint's `realish`/`inScope`), shared by every event** (PostToolUse through `resolveLintTarget`, the skill driver through it, FileChanged, the watch list): the path resolved against the payload `cwd` (never `process.cwd()`) must exist, have a lintable extension (`EXT_MAP` or `TYPE_CHECK_EXTS`), its real path must lie strictly inside realpath(cwd), not be excluded, not lie inside realpath(`scratchpad_dir`) when the payload has one, and not be a dangling link. The lint keeps the lexical path; the real path is the digest key. A Write/Edit through a symlink pointing outside the cwd, or into a scratchpad inside it, is not linted.
- **Watch list** (`watchList`, SessionStart/CwdChanged): `git ls-files -co --exclude-standard -z` (tracked + untracked-not-ignored) in the cwd (`new_cwd` for CwdChanged), filtered through `scopedTarget`. Above `WATCH_LIMIT` (5000) lintable files nothing is watched (stderr note); a git failure (not a repo, no git, timeout) watches nothing.
- **FileChanged skip order** (`fileChangedHandler`, first match wins, every skip = `{}`): `unlink` event; out of scope; content equals the digest Write/Edit recorded; `git --no-optional-locks status --porcelain --untracked-files=normal --ignored=matching -- <fp>` (cwd `dirname(fp)`) prints nothing (tracked, unchanged) or starts with `!!` (ignored). A git failure lints. `add` and `change` are handled alike.
- **Digest store:** PostToolUse records the SHA-256 (base64) of the file on disk at `${CLAUDE_PLUGIN_DATA || os.tmpdir()}/written/<hashPath(real path)>` (temp file + `renameSync`, one file per real path, no locking) before it lints. A missing digest is no match; a write error is swallowed (cost: one duplicate lint). The skill driver records nothing. No pruning (bounded by the number of files ever written). Race: a FileChanged delivered before the digest lands lints twice (duplicate findings, never lost ones).
- **FileChanged lints the whole file:** no edit-range gate (`ranges = null`).
- **Static watch list (dprint F24):** files created after SessionStart/CwdChanged, or replaced by unlink+create, are not watched until the next SessionStart/CwdChanged. Refreshing after Bash commands is a follow-up.

## Path exclusions (`isExcludedPath`)

- Skips `node_modules/`, `vendor/`, `.git/`, plus two Claude-Code-owned subtrees that can land inside a broad `cwd` (e.g. `$HOME`, or a repo root nesting worktrees): `.claude/worktrees/` (harness-created git worktrees, never this session's own content) and `.claude/agent-memory/` (gitignored agent runtime artifacts).
- Any basename containing `.local.` (e.g. `settings.local.json`) is skipped in any directory, matching `.claude/.gitignore`'s `*.local.*` personal-override convention.
- **Deliberately narrow — not a blanket `.claude/` exclusion.** Tracked content under `.claude/` (`rules/`, `agents/`, `skills/`, `settings.json`) must keep getting linted; a `.claude/rules/*.md` edit still triggers markdownlint.
- Exclusion is checked on the path relative to the **real** cwd (inside `scopedTarget`), so a symlinked cwd or file cannot dodge it.

## Measured cost

- **Label:** universal-lint 0.15.1, 2026-11-07, WSL2 6.18.33.2-microsoft-standard-WSL2, 12 cores, 9.5 GB, node v24.22.2, tsc 7.0.2, PATH 63 dirs / 44 on /mnt/c (load 1.42 -> 1.80 during the run). Medians in ms from `node universal-lint/scripts/perf.mts 5`. Numbers are machine- and load-dependent; re-measure before judging a change.
- **Harness:** `node universal-lint/scripts/perf.mts [runs]` after `pnpm --filter universal-lint build` (dev only, measures `plugin/`): spawns the built hook through its shebang with a payload file as stdin, fixtures in `os.tmpdir()`, one warm-up round plus `runs` timed rounds (default 5), real PATH and PATH minus `/mnt/` dirs; exits 1 when a run misses its expected exit status or observable.
- **Live per-hook durations:** `claude -p --debug-file <f> ...`, then `grep 'lint-file.mjs.*finished with status' <f>`; findings appear in transcripts as `hook_blocking_error` attachments carrying `toolUseID`.

| Case                           | real PATH | no /mnt | What runs                                                                                           |
| ------------------------------ | --------: | ------: | --------------------------------------------------------------------------------------------------- |
| floor `node -e 0`              |        24 |      24 | no hook: Node startup + PATH lookup                                                                 |
| empty payload `{}`             |        41 |      40 | hook floor, nothing to lint                                                                         |
| out-of-scope `.json` Write     |        38 |      42 | scope guard only                                                                                    |
| `.sh` Write                    |       132 |      41 | shellcheck: missing tool                                                                            |
| `.py` Write                    |       138 |      44 | ruff: missing tool                                                                                  |
| `.yml` Write                   |       134 |      43 | yamllint: missing tool                                                                              |
| `.md` Write                    |       976 |     798 | markdownlint-cli2: npx fallback, warm cache                                                         |
| `.ts` Write (no eslint config) |       861 |     786 | eslint via npx (no eslint config: skip) + tsc 7.0.2 warm incremental, 30-line fixture: tsc included |
| `.ts` Edit (no eslint config)  |       855 |     811 | same as `.ts` Write: tsc included                                                                   |
| FileChanged tracked unchanged  |        44 |      46 | `git status` skip, ext4                                                                             |
| FileChanged ignored            |        43 |      43 | `git status` `!!` skip, ext4                                                                        |
| FileChanged unlink             |        41 |      39 | early return before any lint                                                                        |
| SessionStart fixture           |        45 |      46 | watch list, 6 lintable files                                                                        |
| SessionStart this repo         |        59 |      60 | watch list of the repo checkout                                                                     |
