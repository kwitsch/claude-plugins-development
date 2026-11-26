---
paths:
  - "tests/**"
---

# Tests

- `tests/*.test.ts`: one file per language/tool or hook area (`file-detection`: SessionStart/CwdChanged watch list and FileChanged linting in a real git repo, with the local `git`/`gitInit` helpers). Exceptions:
  - `registry.test.ts`: unit tests of the exported helpers of `src/hooks/lint-core.ts`.
  - `spawn-group.test.ts`: the `spawnGroup` process-group spawn, its timeout and kill escalation.
  - `manifest.test.ts`: wiring (no `userConfig`, hooks.json, exec bit, README).
- Scaffold, marketplace and root-README checks are not per-plugin tests: the repo-wide guards (layout allowlist, manifest generation, the CI layout check) cover them.
- `tests/support/lint-hook.ts` is the shared harness, not a test file (vitest only runs `*.test.ts`; the subfolder follows `development/vitest/claude-engine/tests/mods/`). It is hermetic: `PATH` holds only `bash`, `node` and `git` (symlinked) plus the linter stubs a test adds (`makeEnv().recStub(name, exit)` records `<name> <argv>`, prints `$OUT`, exits; remove the `git` symlink before stubbing `git`, or the stub overwrites the real binary), `HOME` and `CLAUDE_PLUGIN_DATA` are per-test temp dirs, `GIT_CONFIG_NOSYSTEM=1`, and the built `plugin/mcp/server.mjs` is driven per run. `run(file)` sends a Write/Edit payload, `runEvent(payload)` any event (FileChanged, Stop, SubagentStop, SessionStart, CwdChanged): both one-shot through `tests/support/call-server.ts` (a plain node script: one server, its session key, the tool calls of the event), the watch list through the built `plugin/hooks/watch-paths.mjs`; `HookRun` carries `status`, `stderr`, `stdout` and `ctx`.
- Tests that need state across calls (journal, digests, outbox, keys, worktree scope) use `LintEnv.server()`: one long-lived `startServer` client per test, closed when the file ends (`afterAll`), with `call`, `rpc`, `key` and `notify`. Use it, not `run`, whenever the order of calls is the thing under test. `RunOptions.toolName`/`toolResponse` shape Edit payloads (`structuredPatch` hunks drive the edit-range gate).
- A helper used by one file stays local to that file.
- Late or large stdin (F05): `core.test.ts` drives the hook with its local `runLate` (async `spawn`, stdin pipe, a 512 KB payload written 100 ms after the spawn), the case a synchronous fd-0 read drops with EAGAIN (`hook-design.md` "stdin"). The hook reads stdin asynchronously, so concurrent hook runs (e.g. a burst harness) may feed stdin from a file or any pipe; drive them with async `spawn` (`spawnSync` runs one hook at a time).
