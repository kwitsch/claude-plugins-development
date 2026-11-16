# jev-api

Mods-only plugin: a function-hooks module that registers the System One question types `noul`, `choice`, `score` as tools (`mcp__jev-api__<type>`), plus `batch` (`state` and a `questions` array of `{ type, instructions, criteria }`, one request, answers as a JSON array in question order, all or nothing), and answers them. jevfort asks Jev only through `batch`: renaming it or changing its input or answer shape breaks jevfort.

- Sources: `src/hooks/*.ts` (one module per concern, see each header), `src/shared/http.ts` (the HTTP core), `src/mcp/server.ts` (the transport server). Build, bundle and registration constraints: `.claude/rules/hooks-source.md`.
- Every owned call is answered: a registered tool that no hook answers fails, so never call `next(e)` for `noul`/`choice`/`score`/`batch`, and the hook catches its own throws (a refused `$.env.get`) to answer them too. Every other tool goes to `next(e)`.
- Errors are `{ deny: "<tool>: <reason>" }` (`batch` input errors name the question: `questions[<i>]: ...`).
- The request goes through the bundled MCP server (`plugin/.mcp.json` key `http`), which enforces the timeout and cancels; `$.http.fetch` is only the fallback. Design: `.claude/rules/http-mcp-server.md`; evidence: `development/wiki/plugins/jev-api/tasks/F22-http-through-mcp-server.md`.
- Haiku answers when no Jev variable is set or Jev answers an HTTP error: `.claude/rules/haiku-fallback.md`; history and calibration numbers: `development/wiki/plugins/jev-api/notes/haiku-calibration.md`.
- Oversized states (preflight, overflow modes `error`/`truncate`/`haiku`, learned density): `.claude/rules/oversized-state.md`; measurements: `development/wiki/plugins/jev-api/tasks/F21-oversized-state-sent-blindly.md`.
- Engine static-check pitfalls that shaped the code (no `any`, no `import()`, no bare `$.<noun>`, also in `lib.mjs`; run `claude plugin validate jev-api/plugin` after every hooks change): root `.claude/rules/claude-code-hook-facts.md`.
- Code was copied from jevfort (types, URL regex, request/timeout race), not imported: plugins ship standalone.
- `tests/register.test.ts` has a live smoke block that runs only when `JEV_URL` is set in the shell (plus optional `TYPESAFE_API_KEY`, `TYPESAFE_DEFAULT_MODEL`); never put a URL in the repo.
  - Opt-in by user decision 2026-11-11: live verification against the real server, while CI (no `JEV_URL`) stays green.
  - In a shell that has `JEV_URL` set, a plain test run therefore sends four real requests (`noul`, `choice`, `score`, `batch`); `env -u JEV_URL` keeps a run offline.
- Task list, evaluations and measurements: `development/wiki/plugins/jev-api/index.md`.
