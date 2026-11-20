---
paths:
  - "src/hooks/**"
  - "plugin/hooks/**"
  - "tests/notice.test.ts"
  - "claude-tests/**"
---

# notice (function-hooks toast)

`plugin/hooks/hooks.json` lists `"modules": ["./register.js"]` (Claude Code function hooks, early-access API): a toast
when the working directory has a dprint config but dprint cannot run.

## Constraints

- Layout: `src/hooks/register.ts` (entry: the four `on(...)` calls with inline named hook functions, the state object
  `NoticeState`), `probe.ts` (constants, probe, toast, cwd logic; every function takes `$` and the state), `types.ts`
  (`watch-paths.ts` beside them is the MCP server's command hook, `mcp-server.md`).
  Build: tsdown inlines `types` and `probe` into one `plugin/hooks/register.js` (root `tsdown-build.md`). State
  belongs in `register()`, never at module level.
- The hooks module imports nothing from the skill scripts. `probe.ts` inlines copies of `CONFIG_NAMES`
  (`config-names.ts`), `MIN_VERSION` and check-dprint's `dprint X.Y.Z` regex (`check-dprint.ts`);
  `tests/notice.test.ts` fails when a copy drifts, so change both places.
- The engine's static check wants hooks as named function literals declared in the entry (a top-level helper cannot
  hold the state), so the entry's hooks are thin and call `afterSessionCwd`/`afterCwdChanged` in `probe.ts`.
- `claude plugin validate plugin` checks the module and lists `process.run`, `env.get` and the env vars
  `DPRINT_INSTALL`, `HOME` and `PATH` among its uses (its "gating hook without .catch" warning: root
  `claude-code-tool-hook-facts.md`).

## When it checks

- Hooks `session.start`, `classic.CwdChanged` and `tool.call` for `EnterWorktree`/`ExitWorktree`; lets the event run
  first, then checks detached (errors swallowed).
- The resulting cwd: `new_cwd` for CwdChanged, the tool result's `worktreePath`/`restoredCwd` for the worktree tools,
  else `$.session.cwd()`. It and its ancestors (up to the dir holding `.git`) are searched for `CONFIG_NAMES` with
  `$.fs.exists`. No config: silent, nothing spawned.

## Probe (why it differs from `findDprint`)

Resolution order of `findDprint`: see the skill-scripts rule. The notice judges the one dprint `findDprint` would pick,
with `$.process.run`:

- The first `<abs PATH entry>/dprint` that exists (`$.env.get("PATH")` + `$.fs.exists`; relative entries skipped, a
  weaker check than `findDprint`'s executable-file test), else `$DPRINT_INSTALL/bin/dprint` (default `$HOME/.dprint/bin/dprint`) if it exists
  (`$.env.get("DPRINT_INSTALL")`, `$.env.get("HOME")`), else `npx --no --prefer-offline -- dprint --version`.
- npx uses the cached package only: unlike `findDprint`, which runs on a format request, this runs unprompted, so it
  never downloads. `--prefer-offline` so a name-only spec is not checked against the registry's latest, which fails
  offline or after a release.
- Only the pick is run (`<pick> --version`), never a later candidate, so a broken PATH dprint toasts even when
  `~/.dprint/bin` works (`findDprint` would fail on it too).
- Each probe runs in `cwd` HOME (else, or when that dir does not exist, `/`), never in the project, whose
  `node_modules/.bin` npx would prefer; 10 s timeout.

## Verdict and toast

- Usable = exit 0, stdout matching check-dprint's regex and X.Y.Z >= the inlined `MIN_VERSION` (a prerelease of it
  sorts below).
- The toast names the cause: not installed, `<pick>` could not start or took over 10 s, exited N, printed no dprint
  version, or is too old. The npx leg reads a non-zero exit as not installed (`npx --no` exits 1 when nothing is
  cached); its other causes keep their own text. `judge` returns `{ kind, text }`, so no logic depends on the wording.
- A success is cached for the module's life, a failure for 30 s (its own cache, separate from the MCP server's
  `findDprint`). Only an unusable pick calls `$.ui.toast(text, { timeoutMs: 15000 })`, at most once per 15 s overall
  (the cause is machine-wide).

## Tests

`tests/notice.test.ts` drives `src/hooks/register.ts` through `createKit` from `claude-engine-vitest` (stubs for
`fs.exists`, `session.cwd`, `env.get`, `process.run`, `ui.toast`; `mock.clock(on).settle()` waits for the detached
check). `claude-tests/register.test.ts` fires all four registrations on the built `register.js` under `claude plugin test`.
