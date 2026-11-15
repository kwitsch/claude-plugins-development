# Mods engine: module loading, hook order, budgets, options and state

How Claude Code loads a function-hooks module, in which order hooks run, what a hook may spend, and what `$.env`, `$.store` and `userConfig` really deliver.

The constraints that follow from these facts load by themselves with [claude-code-hook-facts.md](../../../.claude/rules/claude-code-hook-facts.md); this page is the detail and the evidence.

## Loading and reloading

- Each plugin's hooks module is loaded into its own fresh vm context, and `register(on, options)` is called exactly once per load. A hot reload (file edit, changed options, `/reload-plugins`) makes a new environment: the old one's timers are cleared and its host calls throw `environment unloaded`. Module-level `let`s are therefore per load (binary 2.1.322).
- `session.start` fires once per process for each loaded plugin, before the first prompt, and is awaited. A later load (edit, new options, `/reload-plugins`, enable) raises it for that plugin's hooks alone. It is not raised on `/clear` or an in-process `/resume`; `session.end` with reason `clear` or `resume` is (binary 2.1.322).
- A `$.prompt.submit` or `$.command.run` raised under `session.start` skips the wait for `session.start`, so its `prompt.submit` chain runs while `session.start` is still running (binary 2.1.322).
- `register(on)` has no `$`: tools can be registered at `session.start` or lazily at the first `tool.call`, not at module load (live 2.1.322).
- The static check lets `$` be passed only to top-level function declarations; a closure arrow such as `ensureRegistered($)` fails `claude plugin validate` (live 2.1.322).
- The static check reads string literals only. `oxc-minify` with `codegen.removeWhitespace` rewrites every string literal as a template literal, which made the check lose a module's declarations; this is why the entry module is built without that option (build, 2026-11).
- Mods have no `process` global (`ReferenceError`); `URL` and `AbortController` exist (live 2.1.325, docs).

## Order of hooks

- Tiers run `prepend` > `user` > `append` > `builtin` > `core`. Within one rank, when any declaration is sealed, a plugin's manifest `dependencies` are placed beneath (inside of) it and other plugins keep their declared order; otherwise the declared (enable) order holds. Debug log: `hooks module order: dependencies register ...` (binary 2.1.322).
- A plugin that sits between a plugin and its dependency runs inside the upper plugin's `next(e)` before the dependency's hook: read what a dependency registers in `session.start` only after `await next(e)` (binary 2.1.322).
- The managed `cc-plugin-sec-default` (prepend tier) passes these events on past every user-tier hook, so a user-tier plugin hook never runs for them: `classic.Stop` (notice `its classic.Stop hook was skipped`), `session.compact`, `prompt.compose`, `prompt.section`, `prompt.context` (live 2.1.325). Stop-time logic for a mod: do it in `turn.complete` and send Claude back with an unawaited `$.prompt.submit`, with an own pending flag as loop guard.
- No event fires when the tool list changes; `tool.describe` fires only on a tool's first schema render per session. Re-list with `$.tool.list()` per turn to follow another plugin's tools (binary 2.1.322).

## Budget, failures and abandonment

- A hook has 10,000 ms of its own time per dispatch (`catchMs` 1,000, `lingerMs` 5,000). The clock stops while a `$` call or `next` is in flight, except for `$.clock` waits; time spent awaiting an own promise counts (typings 2.1.323, docs).
- A hook that throws, overruns its budget or answers a wrong shape is skipped, and the hooks beneath plus core run in its place (typings). A hook whose `$` call is denied by a hook above is skipped the same way, e.g. `<plugin>'s tool.call hook was skipped: <plugin>: $.env.get: <reason>` (`claude plugin test` 2.1.322).
- Every `$` call can be refused by a higher hook. An unguarded call after `next` (a `$.clock.now` in logging code) then fails a step that already ran: wrap post-`next` work in `try`/`catch` (typings; kit run, 2026-11-14).
- When `next.signal` aborts (interrupt, a hook above settled first, budget) the engine does not abort the hook's in-flight `$` operations, and a new one started after the abort runs normally (`claude plugin test` 2.1.322). Whatever the abandoned hook returns is dropped: conversation state committed for it (sent once, shown, searched) means the next prompt never gets what this one lost (live 2.1.325).
- An in-flight `$.tool.call` does not use up the budget: a 30 s call inside `prompt.submit` was not cut (live 2.1.325).
- A hook's error after `next` is rethrown after the request ran (live 2.1.325).
- In-frame calls: core routes `$.mcp.call` through `$.tool.call` and its permission check although the typings promise no prompt, and a plugin's own hooks see a call the plugin raises only while one of its hooks runs. A permission-checked call (`$.tool.call`, `$.process.run`, storage through `$.mcp.call`) from an unawaited chain or a `$.clock.every` callback therefore gets a permission dialog per call in `default` mode and is denied headless (live 2.1.296).

## Module state across a session

- `session.end` is raised for `/clear` and an in-process `/resume`; no `session.start` follows, and the session gets a new id and with it a new scratchpad directory. State keyed to the conversation (first-turn data, session-id lookups, recent-decision lists) must be reset there as well as on `session.start` (live 2.1.325).
- After a main-conversation `session.compact` the summary has lost context a plugin injected earlier, so "already sent" bookkeeping is reset too; not for `trigger: "precompute"`, not for an event with `agentId` (a subagent's transcript), not when `next`'s result carries `skip` (live 2.1.325).

## Options (`userConfig`)

- Values are type-checked against `plugin.json` before the hooks module loads. A value of the wrong type (a string for a boolean option) makes the whole module fail to load: `options do not fit plugin.json userConfig: ... must be a boolean`. A fallback in code covers absent values only (live 2.1.325).
- Number options accept `min` and `max` in the schema, enforced in the enable dialog and at load (binary 2.1.322). Values that reach a timer or a request are still clamped in code.
- A string option's default arrives in `register(on, options)` as a plain string (live 2.1.325).

## `$.env`, `$.store`, session paths

- `$.env.get` reads `process.env` of the Claude Code process. A shell `export` after launch never reaches it; settings `env` is applied at startup (binary 2.1.322). A project's `.claude/settings.json` `env` overrides the user settings' `env` (live 2.1.325).
- Inside a mod `$.env.get("CLAUDE_PLUGIN_DATA")` and `("CLAUDE_PLUGIN_ROOT")` answer `undefined`; those are exported to hook processes and MCP/LSP servers only (live 2.1.325).
- `$.store` is a JSON key/value file per plugin at `~/.claude/plugins/store/<plugin>_<marketplace>.json`: machine-wide (not per project), persistent across sessions, not atomic. It holds at most 4 MiB of JSON text per plugin; a `$.store.set` over it rejects like a full disk (live 2.1.325).
- `$.fs.write` follows symlinks: an export through a committed symlink overwrote a file outside the cwd. `$.fs.stat` gives `kind` `file|dir|other` and `isLink`; there is no `lstat` or `realpath` (live 2.1.325).
- The session scratchpad is `<CLAUDE_CODE_TMPDIR|TMPDIR|/tmp>/claude-<uid>/<slug of the session-start cwd, not the worktree>/<session id>/scratchpad`; the session id is `$.session.id()` (live 2.1.319).
