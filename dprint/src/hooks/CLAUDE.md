# notice (function-hooks toast)

`plugin/hooks/hooks.json` lists `"modules": ["./notice.mjs"]` (Claude Code function hooks, early-access API).
`notice.mts` hooks `session.start`, `classic.CwdChanged` and `tool.call` for `EnterWorktree`/`ExitWorktree`, lets the
event run, then checks the resulting cwd (`new_cwd` for CwdChanged, the tool result's `worktreePath`/`restoredCwd` for
the worktree tools, else `$.session.cwd()`) and its ancestors (up to the dir holding `.git`) for the `CONFIG_NAMES` (an
inlined copy: the module has no imports; a test checks it against `config-names.mts`) with `$.fs.exists`, detached
(errors swallowed). No config: silent, nothing spawned.

Config found: it judges the one dprint `findDprint` (see `../skills/dprint/CLAUDE.md`) would pick, with
`$.process.run`: the first `<abs PATH entry>/dprint` that exists (`$.env.get("PATH")` + `$.fs.exists`; relative
entries skipped, a weaker check than `findDprint`'s executable-file test), else `$HOME/.dprint/bin/dprint` if it exists
(`$.env.get("HOME")`), else `npx --no --prefer-offline -- dprint --version` (cached package only: unlike `findDprint`,
which runs on a format request, this runs unprompted, so it never downloads; `--prefer-offline` so a name-only spec is
not checked against the registry's latest, which fails offline or after a release). Only the pick is run
(`<pick> --version`), never a later candidate, so a broken PATH dprint toasts even when `~/.dprint/bin` works (as
`findDprint` would fail on it too), each in `cwd` HOME (else, or when that dir does not exist, `/`, never the project,
whose `node_modules/.bin` npx would prefer), 10 s timeout.

Usable = exit 0, stdout `dprint X.Y.Z` (check-dprint's regex) and X.Y.Z >= the inlined `MIN_VERSION` copy (`0.50.0`; a
prerelease of it sorts below; `tests/notice.test.mts` fails when it or the regex drifts from `check-dprint.mts`). The
toast text names the cause: not installed, `<pick>` could not start or took over 10 s, exited N, printed no dprint
version, or is too old (the npx leg reads a non-zero exit as not installed, since `npx --no` exits 1 when nothing is
cached; its other causes keep their own text; `judge` returns `{ kind, text }`, so no logic depends on the wording). A
success is cached for the module's life, a failure for 30 s (its own cache, separate from the MCP server's
`findDprint`). Only when the pick is unusable it calls `$.ui.toast(text, { timeoutMs: 15000 })`, at most once per 15 s
overall (the cause is machine-wide).

`scripts/hooks.mts` validates only the `hooks` map; `claude plugin validate plugin` checks the module, lists
`process.run`, `env.get` and the env vars `HOME` and `PATH` among its uses, and warns "gating hook without .catch" for
three of its hooks (expected: the check is detached with `.catch`).

Build: `hooks/*.mjs` stay unminified (rule in `plugin-src.md`) because Claude Code's static module check needs named
hook functions, `$`/`on` spelled as such and no shadowed names; whitespace removal would turn string literals into
template literals.
