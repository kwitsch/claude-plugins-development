---
paths:
  - "*/src/hooks/**"
  - "development/vitest/claude-engine/**"
---

# Rule: writing a function-hooks module against the mods engine (`$`)

What a hooks edit must respect. Each line is a constraint; how it is known, the exact error texts and everything else about the engine are in the wiki pages named at the end of each section (`development/wiki/facts/`). Read the page before you use an API for the first time in a module or change how it is used. Tool hooks, FileChanged and watchPaths: `claude-code-tool-hook-facts.md`; tools a skill uses: `claude-code-skill-facts.md`. Re-verify with the `live-verify` skill when the Claude Code version changes.

## Module load and static check (fail validate, test or the load)

- No `any`, no `import()` (a module holding `import()` does not load).
- Only the module listed in `hooks.json` may use `$`: the engine rejects passing the mods API into functions imported from another file. It also rejects `$.<noun>` as a bare value (bound, passed or read; `typeof $.mcp?.connect` fails with `$.mcp is used as a value`), and the check covers every module bundled into the hooks entry (`register.js`). Same-file helpers take the whole `$`.
- One hook per event without a matcher (`registered twice without a matcher` fails validate and test).
- `claude plugin validate <plugin>/plugin` runs this check, the vitest kit does not: run it after every hooks change.
- Mod-side permission-checked calls (`$.tool.call`, `$.process.run`, storage through `$.mcp.call`) must be awaited inside a running hook of the module (in-frame). A call from an unawaited chain or a `$.clock.every` callback skips the plugin's own hooks: a permission dialog per call in `default` mode, denied headless.

Loading, hook order, budget, options, `$.env`, `$.store`: [mods-engine-lifecycle.md](../../development/wiki/facts/mods-engine-lifecycle.md).

## Module state

- A dispatch can be abandoned (interrupt, a hook above settled first, budget): `next.signal` aborts and whatever the hook returns is dropped. Check `next.signal?.aborted` after the last `await` and commit no conversation state (sent once, shown, searched) for an abandoned dispatch.
- Conversation state in module memory is reset on `session.start`, on `session.end` (raised for `/clear` and an in-process `/resume`, where no `session.start` follows) and after a main-conversation `session.compact`. Skip the compaction reset for `trigger: "precompute"`, for an event with `agentId` and when `next`'s result carries `skip`. Machine-level caches (binary path, tool list) may survive.
- Every `$` call can be refused by a hook above, and a hook's error after `next` is rethrown after the request ran: catch every `$` call that runs after `next` (`$.store.set` rejects past 4 MiB per plugin).
- A user-tier plugin hook never runs for `classic.Stop`, `classic.SessionStart`, `classic.UserPromptSubmit`, `session.compact`, `prompt.compose`, `prompt.section` and `prompt.context` (`cc-plugin-sec-default` passes them on): do not build on such a hook.

## Tools

- A tool registered with `$.tool.register` runs **without a permission check** (say so in the plugin's README) and its input schema is not enforced: validate every input in the `tool.call` hook.
- Answer a failure with `{ deny: "<tool>: <reason>" }`, never `isError` (core drops it and the model reads a normal result). Cap any text a server controls before it goes into a result.
- `$.tool.register` rejects until the session is bound: retry per hook with back-off instead of memoizing a failure, and answer a registered tool in every state of the plugin (there is no unregister).
- Reading a result: a hook-served tool answers `{ result: "<text>" }`, a real MCP tool `{ result: [{ type: "text", text }], text }`; read `text`, then a string `result`, then the text parts; an empty text is no answer. A refused call (text starting `The user doesn't want to proceed with this tool use`, `Permission for this tool use was denied`, `Permission to use … has been denied`, `Hook '<name>' blocked`) is not tool output.
- `tool.check`: return an existing `allow` unchanged (a reworded reason raises a warning to the user), never answer `ask` to loosen something, and never loosen an `ask` on a `Read` (it means the path lies outside the working directories).

Naming, lifetime, permissions, `$.tool.call` between plugins: [mods-engine-tools.md](../../development/wiki/facts/mods-engine-tools.md).

## Calls that leave the hook

- `$.http.fetch` has no `signal` and runs up to 30 s; headless runs wait for it. Redact every error text in this order: URL, secret, host (whole names only, ignoring case, IPv6 without brackets).
- `$.model.complete(request, options?)`: `signal` is an option, not a request field; `maxTokens` and `timeoutMs` must be whole numbers >= 1 (round seconds * 1000); its own timeout reads `{ isAnswered: false, reason: "aborted" }`; a reply cut at the token limit still counts as answered.
- `$.clock`: for a deadline use `$.clock.after(ms, fn)` and cancel it in `finally`, not a raced `$.clock.sleep`; clamp every delay that comes from options or tool input (above 2^31-1 ms it fires at once); re-check a guard after each `await` inside a `$.clock.every` callback.
- `$.fs.write` follows symlinks: never overwrite a fixed path inside the project; write a new file name after a `$.fs.exists` check. `$.fs` has no `lstat` or `realpath` (`$.fs.stat` answers `isLink`).
- `$.ui.log`: do not prefix the plugin's name, the engine adds it.

Limits, error texts, `$.mcp`, the band above the prompt: [mods-engine-io.md](../../development/wiki/facts/mods-engine-io.md).

## Transcript, prompts, commands

- `$.session.messages` omits meta rows and holds every tool result twice (assistant row and following user row): read one side. A plugin's own `$.prompt.submit` text carries no origin marker in the rows.
- `prompt.submit` carries `turnId` only for a prompt typed while a turn runs.
- `$.command.run({ command: "compact" })` resolves once the compaction ran, also when nothing was compacted: clear a "queued" flag on resolve and on reject.

Row shapes, queueing, what a `session.compact` hook replaces, usage: [mods-engine-session.md](../../development/wiki/facts/mods-engine-session.md). What the test kit cannot show: [test-kit-vs-engine.md](../../development/wiki/facts/test-kit-vs-engine.md).

## Live checks

- Run `claude -p --plugin-dir <plugin> --setting-sources project`, so the user's own settings and installed plugins stay out of the run. `/reload-plugins` may leave a generated `.claude-plugin/types/` folder and a `tsconfig.json` in `plugin/` (untracked, the layout check refuses them): delete them before building.
