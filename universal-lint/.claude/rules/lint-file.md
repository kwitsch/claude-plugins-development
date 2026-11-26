---
paths:
  - "src/hooks/**"
  - "src/mcp/**"
  - "hooks.template.json"
  - "mcp.template.json"
  - "tests/*.test.ts"
  - "scripts/perf.ts"
---

# `lint-core.ts` and the lint server: what must hold

The constraints of the lint hook, one section per area. Each section names its design page in `development/wiki/plugins/universal-lint/design/` (not loaded by itself): the reasons, measurements, accepted residuals and rejected alternatives. **Read the design page before you change that area or "fix" something in it**; most of what looks odd there is deliberate.

## Hook contract

- One stdio MCP server per session (`src/mcp/server.ts`, server `lint`) owns every lint run and all cross-event state, in memory; the mod `src/hooks/register.ts` sends `file_edited` and the idle wake, `mcp_tool` hooks call the other events, `src/hooks/watch-paths.ts` alone serves SessionStart and CwdChanged. [hook-design.md](../../../development/wiki/plugins/universal-lint/design/hook-design.md)
- Five tools: `file_edited` and `next_report` are model-visible (`modelVisible`, `_meta` `["model", "app"]`); `stop`, `file_changed` and `prompt_submitted` are hook-only (`["app"]`). No tasks capability; every handler answers an object, never `isError`.
- The server issues one session key per process to the mod's first call; `file_edited` and `next_report` act only for that key, anything else gets a neutral answer and changes no state. No rotation. [hook-design.md](../../../development/wiki/plugins/universal-lint/design/hook-design.md)
- `next_report` answers one word (`ready`, `timeout`, `busy`) or a key issue, never finding text. Finding text leaves the server only through the keyed `file_edited` answer (`context`), the `stop` block and the `prompt_submitted` context.
- Every capped state map (`written`, `roots`, `scratchpads`, `keys`, `outbox`) is written only through `capSet` with `STATE_CAP` (5000, oldest dropped).
- Budget per tool call: `HOOK_TIMEOUT_MS` (90 s) for an awaited lint, `WAKE_WAIT_MS` (25 s) for `next_report`; no blocking wait in the server (`Atomics.wait`, `execFileSync`, `spawnSync`) on any path a tool call reaches. A cancelled call (`notifications/cancelled`) spawns nothing new and kills the running group.
- Findings are the `universal-lint…: …` text (the hook's `context` or the `stop` reason); nothing to report is `{}`. Every guard failure, clean result, skip, crash, missing tool and cancelled call is silent (fail open).
- Read-only: never pass `--fix`, `--format` or `--write` to a tool, never modify the linted file, never write into the project tree (state lives in the server process; the only files are the fallback under `CLAUDE_PLUGIN_DATA` or the OS temp dir: npx stamp, watch-list output; the PATH probe memo is in server memory).
- Linter children run through `spawnGroup` (detached process group, killed as a whole on timeout and on cancel). Every inner timeout ends before the 90 s budget: re-derive the budget in the design page when a timeout changes.
- A linter's stdout and stderr are both captured and never ignored. Success is decided by each tool's exit-code contract (`classifyExit`), checkstyle by its output; a new tool needs its contract checked against the live tool, not only its docs.
- `lint-core.ts` starts no work at import; each entry (`src/mcp/server.ts`, `src/hooks/watch-paths.ts`, `src/skills/universal-lint/lint-files.ts`) is a separate file.
- Unit tests of the lint state use the `LintEnv.server()` harness (one server process across calls); tests of a single event use `run`/`runEvent`, which drive one-shot through `tests/support/call-server.ts`.
- No `userConfig`, no toggle (`CLAUDE.md`).

Design: [hook-design.md](../../../development/wiki/plugins/universal-lint/design/hook-design.md) (surface of 0.18.0, server lifetime and residuals R1, R2, the reversal of the 2026-11-06 decision, timeout budget, measured cost, `scripts/perf.ts`).

## Who gets a finding, and when

- A Write/Edit lints at once in the server. Its findings go to the agent that made the edit: a main-conversation edit gets its findings as `context` of its own tool result when they are ready, else through the outbox (`next_report` `ready`, the idle wake, or the next `prompt_submitted`), and the turn's last edits through the `stop` block.
- A subagent's edit (`agent_id` in the event) is journaled and not linted at once. Its `SubagentStop` lints its files once and blocks the subagent with the findings.
- A lint reports only when it covers the newest state of the file: unchanged during the lint, no newer journal record of that file and owner, unchanged after the quiet hold (`SETTLE_MS`, 20 s), and its own record claimed. Otherwise it reports nothing and leaves the records for the next lint or the sweep.
- A stop is blocked at most once per owner (`settle/act` marker in memory, per owner); `stop_hook_active` is text in a hook input and is normalised to a boolean.
- The idle wake runs only while the session is idle (between the main `turn.complete` and the next UserPromptSubmit), only when the mod knows the session is not headless (`CLAUDE_CODE_ENTRYPOINT` not starting with `sdk`; first source the mod's `$.env.get`, second the server's key answer), and submits the constant `WAKE_TEXT`.
- `UNIVERSAL_LINT_SETTLE_MS` is a seam for tests and `scripts/perf.ts`, not a setting.

Design: [settle-window.md](../../../development/wiki/plugins/universal-lint/design/settle-window.md) (owner, journal, gate over all pending edits, hold, sweep, delivery matrix, residuals).

## Edit-range gate

- After an Edit, only diagnostics on lines of the file's not yet reported edits count. Diagnostics in other files and text without a located line are kept (fail open means report). An own-file parse error is kept wherever it is reported.
- The gate filters the tool's text after the run, before `truncate()`, with exact lines and no slack; it never changes `buildArgv` or `classifyExit`. `Write`, a missing or malformed patch, and a file with a line break jsdiff does not count are checked whole.
- The patch and the original file come from the engine's `tool.call` result after `next` (`result.structuredPatch` array, `result.originalFile` string), for Write and Edit alike.
- A new output format needs a location case and a test, or its findings pass ungated.

Design: [edit-range-gate.md](../../../development/wiki/plugins/universal-lint/design/edit-range-gate.md) (range source, location regexes, base directory, path matching, residuals).

## Scope, watch list, FileChanged

- `scopedTarget` is the one scope rule for every event: resolved against the call's cwd (never `process.cwd()`), must exist, be lintable, lie with its real path strictly inside the real cwd and not be excluded. [file-detection.md](../../../development/wiki/plugins/universal-lint/design/file-detection.md)
- The scope base of a Write/Edit is `$.session.cwd()` read per edit in the mod's `tool.call`, never cached, never the project root by default. [file-detection.md](../../../development/wiki/plugins/universal-lint/design/file-detection.md)
- FileChanged skips, first match wins: `unlink`; out of scope; content equals the digest Write/Edit recorded; git says ignored or unchanged (a git failure lints). The slot gate comes after these cheap skips, never before.
- The digest store records the content the tool wrote (from the payload), never the disk. It lives in the server, per session.
- The slot cap (an in-process FIFO semaphore) and the project-check lock exist for FileChanged only and are dedup, not debounce: PostToolUse and the skill driver take neither and never wait. Both are per session.
- The FileChanged watch list is fixed at SessionStart and CwdChanged; after EnterWorktree it still belongs to the start directory (R12). Only Write/Edit is covered in a worktree.

Design: [file-detection.md](../../../development/wiki/plugins/universal-lint/design/file-detection.md) (watch list, skip order, slot cap, project-check lock, digest store, path exclusions, worktree scope base).

## Which binary runs

- Selection order: the chain's first tool on `PATH`; else the nearest `node_modules/.bin/<name>` from the file's directory up to the cwd, never above it; else npx (its cached bin directly when fresh, otherwise `npx --yes <package>`). The plugin never rewrites `PATH` and only reads the npm cache.
- A local bin that cannot spawn falls through to npx; a timeout is not retried.
- `tsc` is looked up on `PATH` or in `<cwd>/node_modules/.bin` only; it has no npx fallback.

Design: [npx-and-local-bin.md](../../../development/wiki/plugins/universal-lint/design/npx-and-local-bin.md) (local bin, npx cache and its staleness, trust, PATH probe memo).

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
