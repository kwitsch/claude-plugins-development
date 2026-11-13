---
paths:
  - "*/plugin/hooks/**"
  - "*/src/**"
---

# Rule: verified Claude Code hook behaviour (2.1.323, checked live 2026-11-13)

Facts a plugin author keeps getting wrong. Re-verify with the `live-verify` skill when the Claude Code version changes.

## Tool hooks

- A Bash command that exits non-zero fires **`PostToolUseFailure`**, not `PostToolUse`. A hook that must see every finished Bash call is wired to both (the output's `hookEventName` must match the event, pass `${hook_event_name}`), and a start/finish pair is keyed by `${tool_use_id}` (Pre and both Post events carry it). `scripts/hooks.mts`-style input validators need `PostToolUseFailure` fields (`error`, `is_interrupt`).
- Claude Code's own **Edit** with an empty `new_string` also deletes the line break after `old_string` (with `replace_all`: only occurrences followed by a line break); uniqueness is checked on the unwidened `old_string`. Edits are matched on the LF view of CRLF files and the file's line endings are written back. A hook that returns `updatedInput` must model exactly this.
- `updatedInput` replaces the whole tool input; `additionalContext` of PostToolUse/PostToolUseFailure/PreToolUse reaches the model.
- `mcp_tool` hooks call tools of the plugin's MCP server (hook-only tools carry `_meta.ui.visibility: ["app"]`); `${var}` templates that do not exist for an event are an error: `scripts/hooks.mts --check` guards them.
- A tool's `tool.call` result in a function-hooks module arrives as `{ result }`; the worktree tools' output carries both `worktreePath` and `restoredCwd` (ExitWorktree: use `restoredCwd`).

## FileChanged and watchPaths

- FileChanged hooks only ever get `change` and `add` events (never `unlink`). Claude Code watches each listed **file** on its own: a watched file that is unlinked and recreated (editor save, `git checkout`) loses its watch, racily, and the watch count only falls; files created later are never watched.
- `watchPaths` returned by a FileChanged hook is honoured, but re-listing on every event does not repair lost watches.
- A **directory** in `watchPaths` is watched recursively and survives unlink+create, new files and new subdirectories (also on 9P for changes made from WSL), but every event below it reaches the hook: about 100 events per second (3000 files = 35 s of hook backlog), `.git` writes included. Offer it as an opt-in (env var), never as the default.
- SessionStart and CwdChanged `command` hooks can print `watchPaths`; `mcp_tool` hooks of SessionStart are skipped while the server connects.

## Mods engine (`$`) behaviour (function-hooks modules, checked live on 2.1.325)

- `$.model.complete(request, options?)`: `signal` is an option (second argument), not a request field; `maxTokens` and `timeoutMs` must be whole numbers >= 1 (round seconds * 1000: `2.01 * 1000` is 2009.9999999999998, a refused value); its own timeout comes back as `{ isAnswered: false, reason: "aborted" }`, so tell it from an abandoned call by your own signal.
- `$.http.fetch` errors quote the URL, a DNS failure only the bare host (`getaddrinfo ENOTFOUND <host>`), and a runtime quotes a rejected header value whole (a key with a newline). Redact in this order: URL, secret, host (whole names only, ignoring case, IPv6 without brackets); a secret may contain the host text, a host may be part of ordinary words.
- Tools a plugin registers with `$.tool.register` run **without a permission check**; only a deny rule withholds them. State it in the plugin's README.
- The built-in `cc-plugin-sec-default` bypasses user-tier hooks of several events, now including `session.compact` (debug log `bypassed by cc-plugin-sec-default (tier user)`): a hook that must run there cannot be a user-tier plugin hook.
- An in-flight `$.tool.call` does not use up the hook's 10 s budget (a 30 s call inside `prompt.submit` was not cut); the engine caps one `$.http.fetch` at 30 s.
- Registration: `$.tool.register` rejects until the session is bound (before `session.start`): retry per hook with back-off instead of memoizing a failure, and bound the wait for a registration that never answers (pay it once per tool).

## MCP and misc

- The `initialize` answer carries a version the server supports, never the client's echo. See `mcp-dual-era.md`.
- `claude plugin validate <plugin>` warns `ICON_MISSING` and (for function-hooks modules) "gating hook without .catch" by design; neither is a failure.
- In `claude -p`, `AskUserQuestion` is disabled, so interactive skill flows stop at their first question without changing anything.
