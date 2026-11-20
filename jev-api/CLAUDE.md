# jev-api

Mods-only plugin: a function-hooks module that registers one tool, `request` (`mcp__jev-api__request`: `state` and a `questions` array of `{ type, instructions, criteria }` with type `noul`, `choice` or `score`, one request, answers as a JSON array in question order, all or nothing), and answers it. jevfort asks Jev only through `request`: renaming it or changing its input or answer shape breaks jevfort.

- Sources: `src/hooks/*.ts` (one module per concern, see each header), `src/shared/http.ts` (the HTTP core), `src/mcp/server.ts` (the transport server). Build and registration constraints: `.claude/rules/hooks-source.md`.
- Every owned call is answered: a registered tool that no hook answers fails, so never call `next(e)` for `request`, and the hook catches its own throws (a refused `$.env.get`) to answer them too. Every other tool goes to `next(e)`.
- Errors are `{ deny: "request: <reason>" }` (input errors of a question name it: `questions[<i>]: ...`).
- The request goes through the bundled MCP server (`plugin/.mcp.json` key `http`), which enforces the timeout and cancels; `$.http.fetch` is only the fallback. Design: `.claude/rules/http-mcp-server.md`; evidence: `development/wiki/plugins/jev-api/tasks/F22-http-through-mcp-server.md`.
- Haiku answers when no Jev variable is set or Jev answers an HTTP error: `.claude/rules/haiku-fallback.md`; history and calibration numbers: `development/wiki/plugins/jev-api/notes/haiku-calibration.md`.
- Oversized states (preflight, overflow modes `error`/`truncate`/`haiku`, learned density): `.claude/rules/oversized-state.md`; measurements: `development/wiki/plugins/jev-api/tasks/F21-oversized-state-sent-blindly.md`.
- Engine static-check pitfalls that shaped the code (no `any`, no `import()`, no bare `$.<noun>`, also in every module inlined into `register.js`; run `claude plugin validate jev-api/plugin` after every hooks change): root `.claude/rules/claude-code-hook-facts.md`.
- Tests: unit tests import `src/` (one file per helper module: `tests/{util,input,size,registry,tools}.test.ts`); `tests/server.test.ts` spawns the built `plugin/mcp/server.mjs`; `claude-tests/register.test.ts` runs on the built `register.js` (`pnpm --filter jev-api test:plugin`).
- Code was copied from jevfort (types, URL regex, request/timeout race), not imported: plugins ship standalone.
- `tests/register.test.ts` has a live smoke block that runs only when `JEV_URL` is set in the shell (plus optional `TYPESAFE_API_KEY`, `TYPESAFE_DEFAULT_MODEL`); never put a URL in the repo.
  - Opt-in by user decision 2026-11-11: live verification against the real server, while CI (no `JEV_URL`) stays green.
  - In a shell that has `JEV_URL` set, a plain test run therefore sends one real request (a `noul`, a `choice` and a `score` question); `env -u JEV_URL` keeps a run offline.
- Task list, evaluations and measurements: `development/wiki/plugins/jev-api/index.md`.
