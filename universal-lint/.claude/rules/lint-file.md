---
paths:
  - "src/hooks/**"
  - "plugin/hooks/**"
  - "tests/*.test.ts"
  - "scripts/perf.ts"
---

# `lint-file.ts`: what must hold

The constraints of the lint hook, one section per area. Each section names its design page in `development/wiki/plugins/universal-lint/design/` (not loaded by itself): the reasons, measurements, accepted residuals and rejected alternatives. **Read the design page before you change that area or "fix" something in it**; most of what looks odd there is deliberate.

## Hook contract

- Six `command` hooks share the one entry and `main()` dispatches on `hook_event_name` (a payload without it is PostToolUse). `hooks.json`: PostToolUse `Write|Edit` (index 0, pinned by `tests/manifest.test.ts`) and FileChanged are `asyncRewake` with `timeout: 90`; SessionStart and CwdChanged `timeout: 30`; Stop and SubagentStop synchronous with `timeout: 90`. No `async` flag, no `statusMessage`, no matcher on the non-tool events, no `if` or FileChanged matcher filter.
- Findings are the `universal-lint…: …` text on stderr plus exit 2; nothing to report is no output and exit 0. Every guard failure, clean result, skip, crash or missing tool is silent (fail open).
- Read-only: never pass `--fix`, `--format` or `--write` to a tool, never modify the linted file, never write into the project tree (state goes to `CLAUDE_PLUGIN_DATA`, else the OS temp dir).
- stdin is read with `await json(process.stdin)`, never `readFileSync(0)`; `main` never calls `process.exit`.
- Every Write/Edit starts its lint at once in its own process: no debounce of the lint, no persistent process, no MCP server (user decisions). Only the report of findings waits (next section).
- Linter children run through `spawnGroup` (detached process group, killed as a whole on timeout and when the hook gets SIGTERM/SIGINT/SIGHUP). Every inner timeout ends before the 90 s hook timeout: re-derive the budget in the design page when a `hooks.json` `timeout` or any `*_TIMEOUT_MS` changes.
- A linter's stdout and stderr are both captured and never ignored. Success is decided by each tool's exit-code contract (`classifyExit`), checkstyle by its output; a new tool needs its contract checked against the live tool, not only its docs.
- No `userConfig`, no toggle (`CLAUDE.md`).

Design: [hook-design.md](../../../development/wiki/plugins/universal-lint/design/hook-design.md) (hooks, command hooks instead of a server, timeout budget, runtime behaviour, measured cost, `scripts/perf.ts`).

## Who gets a finding, and when

- Findings go to the agent that made the edit. An edit with `agent_id` in the payload is journaled and not linted; that agent's `SubagentStop` lints its files once and reports to it. The main conversation's findings wait until it has made no Write/Edit for the quiet time; `Stop` sweeps what is still unreported.
- A lint reports only when it covers the newest state of the file: unchanged during the lint, no newer journal record of that file and owner, unchanged after the hold, and its own record claimed. Otherwise it reports nothing and leaves the records for the next lint or the sweep.
- Without a journal record (unwritable data dir) a lint reports at once; a stop is blocked at most once; a broken chain of records means the whole file is checked (report more, never less).
- `UNIVERSAL_LINT_SETTLE_MS` is a seam for tests and `scripts/perf.ts`, not a setting.

Design: [settle-window.md](../../../development/wiki/plugins/universal-lint/design/settle-window.md) (owner, journal, gate over all pending edits, hold, sweep, headless, residuals).

## Edit-range gate

- After an Edit, only diagnostics on lines of the file's not yet reported edits count. Diagnostics in other files and text without a located line are kept (fail open means report). An own-file parse error is kept wherever it is reported.
- The gate filters the tool's text after the run, before `truncate()`, with exact lines and no slack; it never changes `buildArgv` or `classifyExit`. `Write`, a missing or malformed patch, and a file with a line break jsdiff does not count are checked whole.
- A new output format needs a location case and a test, or its findings pass ungated.

Design: [edit-range-gate.md](../../../development/wiki/plugins/universal-lint/design/edit-range-gate.md) (range source, location regexes, base directory, path matching, residuals).

## Scope, watch list, FileChanged

- `scopedTarget` is the one scope rule for every event: the path is resolved against the payload `cwd` (never `process.cwd()`), must exist, have a lintable extension, lie with its real path strictly inside the real cwd, not be excluded (`node_modules/`, `vendor/`, `.git/`, `.claude/worktrees/`, `.claude/agent-memory/`, any `*.local.*`), not lie in the session scratchpad and not be a dangling link. `.claude/` as a whole is not excluded.
- FileChanged skips, first match wins: `unlink`; out of scope; content equals the digest Write/Edit recorded; git says ignored or unchanged (a git failure lints). The slot gate comes after these cheap skips, never before.
- The digest store records the content the tool wrote (from the payload), never the disk.
- The slot cap and the project-check lock exist for FileChanged only and are dedup, not debounce: PostToolUse and the skill driver take neither and never wait.

Design: [file-detection.md](../../../development/wiki/plugins/universal-lint/design/file-detection.md) (watch list, skip order, slot cap, project-check lock, digest store, path exclusions).

## Which binary runs

- Selection order: the chain's first tool on `PATH`; else the nearest `node_modules/.bin/<name>` from the file's directory up to the cwd, never above it; else npx (its cached bin directly when fresh, otherwise `npx --yes <package>`). The plugin never rewrites `PATH` and only reads the npm cache.
- A local bin that cannot spawn falls through to npx; a timeout is not retried.
- `tsc` is looked up on `PATH` or in `<cwd>/node_modules/.bin` only; it has no npx fallback.

Design: [npx-and-local-bin.md](../../../development/wiki/plugins/universal-lint/design/npx-and-local-bin.md) (local bin, npx cache and its staleness, trust, PATH probe cache).

## TypeScript type check

- `.ts`, `.tsx`, `.mts`, `.cts` get a second, whole-project `tsc --noEmit -p <nearest tsconfig.json up to the cwd>`; solution-style tsconfigs are skipped; plain JS never triggers it.
- It is skipped only when oxlint really ran with a config whose `options.typeCheck` is `true`; a speculative `tsc` never runs.
- Trust the live exit codes (0 clean, 1 or 2 issues, anything else skip, plus the content pass for exit 1), not the documented enum. The build-info cache lives in the data dir, never in the cwd.

Design: [typescript-check.md](../../../development/wiki/plugins/universal-lint/design/typescript-check.md).

## YAML and Markdown line length

- yamllint and markdownlint get exactly their max-line-length rule switched off, and only when neither the project nor the user has a config for that tool. The config walks are deliberately not bounded at the cwd.
- markdownlint-cli2 gets `--no-globs` first, before any `--config` and the file.

Design: [line-length-guard.md](../../../development/wiki/plugins/universal-lint/design/line-length-guard.md).

## Languages

- JSON is not covered on purpose: [languages.md](../../../development/wiki/plugins/universal-lint/design/languages.md).
- JS/TS: the nearest config file picks eslint or oxlint (oxlint wins a tie in one directory); no config means no chain lint (`tsc` still runs); selection is by file name only. oxlint gets `-c <config>` and `--no-error-on-unmatched-pattern`; a selected but unavailable oxlint never falls back to eslint. [lang-jsts.md](../../../development/wiki/plugins/universal-lint/design/lang-jsts.md)
- CSS/SCSS: stylelint runs only when a stylelint config exists; exit 0 clean, 2 issues, anything else skip. [lang-css.md](../../../development/wiki/plugins/universal-lint/design/lang-css.md)
- PHP: phpstan, then psalm, `PATH` only; no `vendor/bin` lookup. [lang-php.md](../../../development/wiki/plugins/universal-lint/design/lang-php.md)
- Rust: probe `cargo-clippy` but spawn `cargo clippy --manifest-path <nearest Cargo.toml> -- -D warnings`; a missing clippy component falls back to `cargo check`. [lang-rust.md](../../../development/wiki/plugins/universal-lint/design/lang-rust.md)
- Go: golangci-lint, then `go vet`, with the file's package directory as target, `PATH` only. [lang-go.md](../../../development/wiki/plugins/universal-lint/design/lang-go.md)
- yamllint gets its target as `./<path relative to the spawn cwd>`, never absolute, and runs without `--strict`.

## Changing this file's subject

- A behaviour change updates its design page in the same commit; a new constraint gets one line here, its reasons go to the design page or the task document.
