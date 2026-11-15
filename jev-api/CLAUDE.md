# jev-api

Mods-only plugin: a function-hooks module that registers the System One question types `noul`, `choice`, `score` as tools (`mcp__jev-api__<type>`), plus `batch` (`state` and a `questions` array of `{ type, instructions, criteria }`, one request, answers as a JSON array in question order, all or nothing), and answers them. jevfort asks Jev only through `batch`: renaming it or changing its input or answer shape breaks jevfort.

- Sources: `src/hooks/*.ts` (one module per concern, see each header; only `register.mjs` is in `hooks.json`, the rest is bundled into `plugin/hooks/lib.mjs`), `src/shared/http.ts` (the HTTP core), `src/mcp/server.ts` (the transport server). Build, bundle and registration constraints: `.claude/rules/hooks-source.md`.
- Every owned call is answered: a registered tool that no hook answers fails, so never call `next(e)` for `noul`/`choice`/`score`/`batch`, and the hook catches its own throws (a refused `$.env.get`) to answer them too. Every other tool goes to `next(e)`.
- Errors are `{ deny: "<tool>: <reason>" }` (`batch` input errors name the question: `questions[<i>]: ...`): core drops a hook's own `isError` (live on 2.1.322 the model got the error as a normal result), while a `deny` reaches it as an error result.
- The request goes through the bundled MCP server (`plugin/.mcp.json` key `http`), which enforces the timeout and cancels; `$.http.fetch` is only the fallback, where an abandoned request runs on, so callers still keep `timeout` at or below their own budget (jevfort: equal to its 4 s budget, 9 s for a compaction ranking). Design: `.claude/rules/http-mcp-server.md`; evidence: `docs/tasks/F22-http-through-mcp-server.md`.
- Haiku answers when no Jev variable is set or Jev answers an HTTP error: `.claude/rules/haiku-fallback.md`; history and calibration numbers: `docs/HAIKU-CALIBRATION.md`.
- Oversized states (preflight, overflow modes `error`/`truncate`/`haiku`, learned density): `.claude/rules/oversized-state.md`; measurements: `docs/tasks/F21-oversized-state-sent-blindly.md`.
- Engine pitfalls that shaped the code: no `claude-code` type import, no `any`, no `import()`, no `$.<noun>` passed as a bare value, one matcher-less hook per event, hooks are named function literals; `hooks/*.mjs` is built unmangled.
- The engine's static check applies to every module of `lib.mjs` (`typeof $.mcp?.connect` failed the load: `$.mcp is used as a value`); `claude plugin validate jev-api/plugin` catches that, the vitest kit does not, so run it after every hooks change.
- Code was copied from jevfort (types, URL regex, request/timeout race), not imported: plugins ship standalone.
- Commands: `pnpm --filter jev-api build`, `pnpm --filter jev-api test`, `pnpm lint`, `claude plugin validate jev-api/plugin`.
- `tests/register.test.ts` has a live smoke block that runs only when `JEV_URL` is set in the shell (plus optional `TYPESAFE_API_KEY`, `TYPESAFE_DEFAULT_MODEL`); never put a URL in the repo.
- Task list, evaluations and measurements: `docs/README.md`.
