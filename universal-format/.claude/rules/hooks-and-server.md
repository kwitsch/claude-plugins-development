---
paths:
  - "src/mcp/**"
  - "plugin/hooks/**"
  - "plugin/.mcp.json"
---

# Hook, server and handler: what must hold

Each section names its design page in `development/wiki/plugins/universal-format/design/` (not loaded by itself). **Read the design page before you change that area or "fix" something in it**; most of what looks odd is deliberate.

## Hook contract

- One hook: PreToolUse `Write|Edit`, `mcp_tool`, server `plugin:universal-format:universal-format-hooks` (the namespaced name, never the bare `.mcp.json` key), tool `format_pre`, `timeout: 60`, no `async`, no `if`. Never add a hook that runs after the write, a `CwdChanged` hook or an `EnterWorktree` hook.
- The hook's `input` template is required and lists exactly the fields the handler reads (`cwd`, `tool_name`, `tool_input.file_path/content/old_string/new_string/replace_all`): without `input` the tool gets `{}`. A new field the handler reads needs its placeholder there.
- The template substitutes text: a boolean arrives as `"true"`/`"false"`, a field the tool call lacks as `""`. Keep the comparison of `replace_all` against both `true` and `"true"`.
- `format_pre` never sets `permissionDecision`; it answers `updatedInput` plus the `additionalContext` notice, or `{}`.
- Every guard failure and every error answers `{}` (fail open). Whether something is written is decided by the content diff, never by an exit code.
- The hook stays synchronous and the handler never writes the file itself.

Design: [hook-design.md](../../../development/wiki/plugins/universal-format/design/hook-design.md).

## Server

- Dual-era as the repo rule `.claude/rules/mcp-dual-era.md` says, modelled on `dprint/src/mcp/server.ts`; the tool carries `_meta.ui.visibility: ["app"]`; `.mcp.json` starts it with `command: "node"`, no launcher script, no `env`.
- The version comes from `../.claude-plugin/plugin.json` at start, never from the build.
- A cancelled call gets no answer and its CLI formatter is killed (the handler passes the `AbortSignal` to the spawn).
- Never a single "current cwd" in module state: concurrent calls of subagents carry different cwds; every cache is keyed by the directory it describes.

## Scope: `cwd` is a hint, `resolveBase` is the anchor

- No outside-cwd guard and no project-membership gate: a file anywhere is formatted, against the base `resolveBase` picks (the cwd when it contains the file, else the file's git root below `$HOME`, else its own directory).
- The payload's `cwd` is used as it is, only normalised with `path.resolve`; no cwd tracking, no per-agent override.
- `relativeIfContains` stays `path.relative`-based, never a `startsWith` prefix test. `.git` is existence-checked (it is a file in a worktree).
- `isExcludedPath` gets the base-relative path, never the absolute one; the absolute check for `.claude/worktrees` and `.claude/agent-memory` applies only when the base is not the cwd. No blanket `.claude/` exclusion.

Design: [scope-and-base.md](../../../development/wiki/plugins/universal-format/design/scope-and-base.md).

## dprint gate

- Inside a cwd that dprint governs (a dprint config found by dprint's own walk from the cwd, and the dprint plugin enabled in the most specific settings file) the handler answers `{}` for every language; a file outside the cwd is still formatted.
- Neither the config walk nor the settings are cached. A config-file write is noted before the gate returns.
- `DPRINT_CONFIG_NAMES` is a copy of dprint's `CONFIG_NAMES`; `tests/dprint-gate.test.ts` compares them.

Design: [dprint-gate.md](../../../development/wiki/plugins/universal-format/design/dprint-gate.md).

## Bundled prettier

- One prettier, the vendored one, formats every prettier language; never look up a project's, a PATH or an `npx` prettier. A project's prettier config, `.editorconfig` and `.prettierignore` are honored.
- `<base>/.prettierignore` is the only ignore source; `.gitignore` is not one. prettier alone decides what matches.
- The java, php and shell plugins load on first use, never at import: java/php/shell their own, Markdown all three, a Markdown host (JS/TS, HTML, Vue) all three only when its source names `md` or `markdown`. Keep the `unhandledRejection` guard in `prettier.ts`.
- No plugin option is ever set from this code (never `experimentalWasm`).
- An unresolvable entry of a project's `plugins` leaves the file unformatted; never format without it.
- JSON and YAML only: `printWidth` is lifted to 99999 when neither a prettier project config nor an `.editorconfig` `max_line_length` governs the file and prettier itself resolved no width; both walks are unbounded.

Design: [bundled-prettier.md](../../../development/wiki/plugins/universal-format/design/bundled-prettier.md), [printwidth-guard.md](../../../development/wiki/plugins/universal-format/design/printwidth-guard.md).

## Caches

- prettier's config cache is never cleared per format. A Write/Edit of a config-like file leaves a pending refresh with the file's stamp; the first later format that finds the stamp changed clears the config caches and, for a `.prettierignore`, re-reads the ignore state of the file's own directory (the only base it governs).
- The pending note is taken before the language guard.
- A config or ignore file changed outside Write/Edit is not picked up until the server restarts (accepted, tested).

Design: [caches.md](../../../development/wiki/plugins/universal-format/design/caches.md).

## CLI formatters

- Kotlin, Python, Go and Rust only; each tool reads stdin and prints to stdout, named the real path through its `stdinArgs`. stdout is trusted only when the exit code is in the tool's `okExit` and stdout is not empty.
- Spawned asynchronously, never `spawnSync`; the inner timeout stays below the hook's `timeout`.
- `~/.local/bin` is appended to the server's PATH at the first lookup (appended: the inherited PATH wins); the PATH answer per tool is cached for the life of the process.
- An Edit formats the whole merged file and hands the Edit tool only the changed run of whole lines (`shrinkSwap`); a CRLF file is handled in LF throughout.
- A tool is spawned in the nearest existing directory: a Write may create the file's directory only when it lands.

Design: [cli-formatters.md](../../../development/wiki/plugins/universal-format/design/cli-formatters.md), [hook-design.md](../../../development/wiki/plugins/universal-format/design/hook-design.md).
