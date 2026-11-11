# jev-api

Mods-only plugin: a function-hooks module that registers the System One question types `noul`, `choice`, `score` as tools (`mcp__jev-api__<type>`) and answers them.

- `src/hooks/register.mts` holds everything (types, `SPECS`, `endpoint`, `parseInput`, `detail`, `ask`, `register`): no imports, HTTP through `$.http.fetch`. Two matcher-less hooks: `session.start` always registers the three tools (`Promise.allSettled`; a failed one is logged via `$.ui.log`) and records the name the engine returned for each, `tool.call` answers those names (fallback: the `mcp__jev-api__` prefix) and passes every other tool to `next(e)`. A registered tool that no hook answers fails, so never call `next(e)` for `noul`/`choice`/`score`.
- Call-time gate: on every call, before input validation, at least one of `TYPESAFE_API_KEY`, `TYPESAFE_BASE_URL`, `JEV_URL` must be non-blank, else a local `isError` without a request. Endpoint: `JEV_URL` > `${TYPESAFE_BASE_URL}/v1/systemone` > `https://api.typesafe.ai/v1/systemone`; an invalid set value is an error, never a fallback. Model `TYPESAFE_DEFAULT_MODEL` or `jev-latest`; timeout 30 s via `$.clock.after`, cancelled when the request settles. The bearer key is sent only to an https endpoint; over http the same request goes out without `Authorization`.
- Engine pitfalls that shaped the code: no `claude-code` type import, no `any`, no `import()`, no `$.<noun>` passed as a bare value, one matcher-less hook per event, hooks are named function literals; `hooks/*.mjs` is built unmangled.
- Code was copied from jevfort (types, URL regex, request/timeout race), not imported: plugins ship standalone.
- Commands: `pnpm --filter jev-api build`, `pnpm --filter jev-api test`, `pnpm lint`, `claude plugin validate jev-api/plugin`.
- `tests/register.test.mts` has a live smoke block that runs only when `JEV_URL` is set in the shell (plus optional `TYPESAFE_API_KEY`, `TYPESAFE_DEFAULT_MODEL`); never put a URL in the repo.
