---
paths:
  - "*/src/hooks/**"
  - "development/vitest/claude-engine/**"
---

# Rule: verified mods engine (`$`) behaviour for function-hooks modules (2.1.323, checked live 2026-11-13)

Facts a plugin author keeps getting wrong. Re-verify with the `live-verify` skill when the Claude Code version changes. Tool hooks, FileChanged and watchPaths: `claude-code-tool-hook-facts.md`; tools a skill uses: `claude-code-skill-facts.md`.

## Function-hooks module state (graphmind-helper bug hunt, 2.1.325)

- A tool's `tool.call` result in a function-hooks module arrives as `{ result }`; the worktree tools' output carries both `worktreePath` and `restoredCwd` (ExitWorktree: use `restoredCwd`).
- A real MCP tool's `$.tool.call` result is `{ result: [{ type: "text", text }], text }`; a tool registered through `$.tool.register` answers `{ result: "<text>" }`. Read `text`, then a string `result`, then the text parts; an empty text is no answer.
- A dispatch can be abandoned (interrupt, a hook above settled first, budget): `next.signal` aborts and whatever the hook returns is dropped. Check `next.signal?.aborted` after the last `await` and commit no conversation state (sent once, shown, searched) for an abandoned dispatch, or the next prompt never gets what this one lost.
- Conversation state in module memory is reset on `session.start`, on `session.end` (raised for `/clear` and `/resume`, where no `session.start` follows) and after a main-conversation `session.compact` (the summary loses injected context). Skip the compaction reset for `trigger: "precompute"`, for an event with `agentId` (a subagent's transcript) and when `next`'s result carries `skip`. Machine-level caches (binary path, tool list) may survive the reset.
- A cache flag set before an `await` lets parallel calls race past it: re-check the flag after the await before spending a once-per-session action.

## Mods engine (`$`) behaviour (2.1.323 typings, checked live on 2.1.325 except where marked)

- `$.model.complete(request, options?)`: `signal` is an option (second argument), not a request field; `maxTokens` and `timeoutMs` must be whole numbers >= 1 (round seconds * 1000: `2.01 * 1000` is 2009.9999999999998, a refused value); its own timeout comes back as `{ isAnswered: false, reason: "aborted" }`, so tell it from an abandoned call by your own signal.
- `$.http.fetch` errors quote the URL, a DNS failure only the bare host (`getaddrinfo ENOTFOUND <host>`), and a runtime quotes a rejected header value whole (a key with a newline). Redact in this order: URL, secret, host (whole names only, ignoring case, IPv6 without brackets); a secret may contain the host text, a host may be part of ordinary words.
- Tools a plugin registers with `$.tool.register` run **without a permission check**; only a deny rule withholds them. State it in the plugin's README.
- The built-in `cc-plugin-sec-default` bypasses user-tier hooks of several events, now including `session.compact` (debug log `bypassed by cc-plugin-sec-default (tier user)`): a hook that must run there cannot be a user-tier plugin hook.
- An in-flight `$.tool.call` does not use up the hook's 10 s budget (a 30 s call inside `prompt.submit` was not cut); the engine caps one `$.http.fetch` at 30 s.
- Registration (typings and an in-process harness, not measured live): `$.tool.register` rejects until the session is bound (before `session.start`): retry per hook with back-off instead of memoizing a failure, and bound the wait for a registration that never answers (pay it once per tool).
- A `tool.call` hook's own `isError` is dropped by core: the model gets the text as a normal result (live, 2.1.325). Answer a failure with `{ deny: "<tool>: <reason>" }`, which reaches the model as an error result. A result read back through `$.tool.call` carries `isError: true` or `deny`.
- `$.tool.register` input schemas are not enforced (`enum`, `required`, `type` and bounds only describe the tool to the model): the hook gets whatever was sent, so validate every input in the `tool.call` hook.
- `$.fs.write` follows symlinks (live, 2.1.325): never overwrite a fixed path inside the project (a committed symlink sends the write outside the cwd); write a new file name after a `$.fs.exists` check.
- `$.store` holds at most 4 MiB of JSON text per plugin; a `$.store.set` over it rejects like a full disk, and a hook's error after `next` is rethrown after the request ran: catch every store call that runs after `next`.
- `$.http.fetch` has no `signal`: a timed-out or abandoned request runs on until it settles or hits the 30 s cap, and in `claude -p` and other headless runs the process and the next prompt wait for it.
- `$.session.messages` omits meta rows and carries no origin marker for a plugin's own `$.prompt.submit` text; a slash command that started a turn appears as a `<command-message>` row (arguments raw, a `<` stays), a local command (`/jev`) as a `<command-name>` row with no stdout row, and its skill text is not in the list.
- A `tool.check` hook that returns an existing `allow` with a new `reason` makes `cc-plugin-sec-default` warn the user that a plugin tried to reword an allow rule: return an allow unchanged.
- `$.clock.sleep(ms)` has no cancel: a budget raced with `Promise.race` stays pending after the race settled (one timer per call left behind). Use `$.clock.after(ms, fn)`, which returns `{ cancel }`, and cancel it in `finally` (typings; source: jevfort F08).
- /clear and an in-process /resume raise `session.end` but no `session.start`, and give the session a new id and with it a new scratchpad directory: drop per-conversation state (first-turn data, session-id lookups, recent-decision lists) in `session.end` too.
- A `prompt.submit` event carries `turnId` only for a prompt typed while a turn runs (absent while idle): use it to tell a mid-turn prompt from a new request.
- `$.command.run({ command: "compact" })` resolves once the compaction ran (after the turn): clear a "compaction queued" flag on resolve as well as on reject; the `session.compact` hook that would clear it may be bypassed.
- A tool call refused before it ran comes back as an error result whose text starts with `The user doesn't want to proceed with this tool use`, `Permission for this tool use was denied`, `Permission to use … has been denied` or `Hook '<name>' blocked` (2.1.325); a failed run does not match. A plugin acting on a result must not treat these as tool output.
- `$.fs.stat` answers `isLink` for a symlink; `$.fs` has no realpath or lstat otherwise. Claude Code already allows in-project reads, so its `ask` on a `Read` means the path resolves outside the working directories: never loosen that ask.
- For live checks run `claude -p --plugin-dir <plugin> --setting-sources project`, so the user's own settings and installed plugins stay out of the run; `/reload-plugins` may leave a generated `.claude-plugin/types/` folder and a `tsconfig.json` in `plugin/` (untracked, the layout check refuses them): delete them before building.
