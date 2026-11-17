# Hook design (do not "fix" without reading this)

Why universal-format is one PreToolUse `mcp_tool` hook on a persistent MCP server, what its input template must hold, how an Edit is rewritten, and what was removed on purpose.

## One hook, before the write

- PreToolUse `Write|Edit` calls `format_pre`; every one of the 17 languages is formatted before the write and handed back as `hookSpecificOutput.updatedInput`. Nothing runs after the write and nothing ever runs against the file on disk.
- Removed in 0.19.0, do not restore:
  - the PostToolUse `format_post` hook: the CLI languages were reformatted on disk after the write, which was a second write of the same file, a second hook round-trip on every Write/Edit (about 7 ms of a 44 ms Write round-trip, measured on 2.1.303, former repository) and a code path of its own;
  - the `CwdChanged` `cwd_changed` cache prefetch (about 2 ms saved once per `cd`, at the price of a hook, a tool and a code path);
  - the PostToolUse `EnterWorktree` `worktree_entered` cwd override ([scope-and-base.md](scope-and-base.md), "History").
- `timeout: 60`, no `async`, no `if`. An `if` rule matches one tool and one path pattern per handler, so filtering 30 extensions times 2 tools would need dozens of handlers; the handler's extension table is the filter, and an unsupported file costs it about 0.1 ms plus the round-trip (measured before 0.19.0, former repository).
- The hook stays synchronous: the reformat must land, and the model must see the "re-read before further edits" notice, before its next tool call touches the file.
- The server is persistent, so prettier stays warm: a warm format of a small TypeScript file takes about 3 ms, the first one about 60 ms, a server start about 55 ms (measured 2026-11-17, [vendor-build.md](vendor-build.md)).

## The `input` template is required

- An `mcp_tool` hook without `input` delivers `arguments: {}`, not the hook JSON (live 2.1.226): the handler would format nothing while the hook reports success. `tests/manifest.test.ts` pins the exact template.
- The server name in the hook is the namespaced `plugin:universal-format:universal-format-hooks`; the bare `.mcp.json` key does not connect (live 2.1.226).
- Substitution is text (live 2.1.326, probe server logging the arguments): `tool_input.replace_all` of an Edit arrives as `"false"`/`"true"`, and a field the tool call lacks arrives as `""` (`old_string`, `new_string`, `replace_all` of a Write; `content` of an Edit). `formatPre` therefore compares `replace_all` against `true` and `"true"`; do not reduce it to a boolean comparison.
- The command-hook payload of the same event carries the real boolean and omits the absent fields (live 2.1.326).

## What `format_pre` answers

- Never `permissionDecision`: `"allow"` would approve every Write/Edit, `"defer"` would drop the rewrite. Only `updatedInput` and the `additionalContext` notice.
- Success is decided by the content diff, never by an exit code. Every error and every guard failure answers `{}`. For a CLI tool the exit code only gates whether its stdout is trusted ([cli-formatters.md](cli-formatters.md)).
- The notice names the base-relative path when the base is the cwd and the absolute path otherwise: a relative path is ambiguous once files of several projects are formatted in one session.

## Edit: format the whole file, swap the changed lines

- A fragment cannot be formatted alone, so the Edit is applied in memory (`applyEdit`, with the Edit tool's contract: not found or not unique gives `null`, and the original Edit proceeds and reports it), the whole merged file is formatted, and `shrinkSwap` hands the Edit tool the changed run of whole lines: `{ file_path, old_string: <run of the file on disk>, new_string: <the same run, formatted>, replace_all: false }`.
- The run is widened line by line, upward first, until `applyEdit` reproduces the formatted file from it (so `old_string` is unique and not empty), at most `MAX_WIDENINGS` (32) times; past that the whole file is swapped. Real edits widen 1 to 10 times (p99 5, measured 2026-10); the bound keeps thousands of identical lines from a quadratic scan.
- Effect: a one-line edit of a 450 KB file sends 1.3 KB instead of 1.9 MB (measured before 0.19.0, former repository). The Edit tool's result is a one-line confirmation either way (live 2.1.303), so this saves pipe payload and harness work, not model tokens.
- When the formatter turns the edit straight back into the file on disk, `shrinkSwap` returns `null` and the handler answers a no-op Edit (`old_string == new_string`, the original `replace_all`) with a notice: the file stays formatted, where the raw edit would have landed unformatted.
- The Edit tool matches `old_string` against LF-normalised content and writes CRLF back to a CRLF file itself (live 2.1.303). For such a file the whole path runs on LF text, file and formatter output alike: a `\r\n` in the swap could never match.
- An empty `old_string` is rejected: `"".includes` and `indexOf("")` both "match", and `replace_all` would splice `new_string` between every character.

## Server

- Dual-era, modelled on dprint's server ([mcp-protocol-eras.md](../../../facts/mcp-protocol-eras.md)). Claude Code 2.1.326 connects in the 2026-07-28 era (`server/discover` first; a server that answers `-32601` to it gets `initialize`) (live 2.1.326).
- The tool is hidden from the model by `_meta.ui.visibility: ["app"]`; the debug log confirms `tool "format_pre" is kept from the model` while the hook calls it (live 2.1.326).
- Claude Code stops the server with SIGINT (live 2.1.326, debug log). The server no longer turns signals into `process.exit(0)`: that existed only so node wrote its compile cache, which went with the launcher ([vendor-build.md](vendor-build.md), "What went with the launcher").
- Cancellation: the handler passes the call's `AbortSignal` to the CLI formatter's spawn, so a cancelled call (a hook that hit its timeout) kills the tool. A prettier format already running in-process finishes; its result is dropped.

## No toggle

- No `userConfig`: formatting is the whole plugin, so a switch would equal uninstalling. The former marketplace rule "every feature gets a boolean toggle" had an explicit exception for this plugin and universal-lint (2026-07-24).
