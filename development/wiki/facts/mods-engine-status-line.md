# Mods engine: the StatusLine site and live usage

What the mods engine does for a mod that substitutes the status line text and refreshes it from a timer: the `ui.render` `StatusLine` site, `$.session.usage().rateLimits` after a turn ended, `session.measure`, and `$.fs` from a `$.clock.every` callback. Checked with the statusbar probe; usage basics are in [mods-engine-session.md](mods-engine-session.md).

## L1: the `StatusLine` render site and `props.text`

Outcome: passed

- `claude plugin validate` accepts `on("ui.render", { component: "StatusLine" }, ...)`; it lists the hook as `ui.render{component=StatusLine}` (live 2.1.332).
- The event a user-tier hook sees: `{ surface: "terminal", component: "StatusLine", viewport: { columns, rows, isFullscreen }, requestId: "site:status-line", props: { text, isManaged: false, isWorking: false, maxRows: 5, columns } }`; `props.columns` was `viewport.columns - 4` (live 2.1.332).
- With the user's `statusLine` settings entry present, `props.text` holds the status line command's output (the line `statusline-command.sh` printed) (live 2.1.332).
- `next({ ...e, props: { ...e.props, text } })` is what the terminal shows: the status row showed only the substituted text, once, not doubled and not beside the command's line (live 2.1.332).
- ANSI codes in the substituted `props.text` are rendered: `\x1b[0;32m` showed as green (SGR 32 on the captured screen) (live 2.1.332).
- Without a `statusLine` entry (interactive `--setting-sources project`) the site still renders and calls the hook, with `props.text: null`; the substituted text is shown (live 2.1.332).
- The site re-renders after `$.ui.invalidate("ui.render")` from a `$.clock.every` callback: the shown counter followed the timer ticks while the session was idle (live 2.1.332).

## L2: `rateLimits` freshness after the turn ended

Outcome: passed

- `$.session.usage()` answers `{ startedAt, context: { tokens, window, percent }, rateLimits: [{ kind: "five_hour", percentUsed, resetsAt }, { kind: "seven_day", percentUsed, resetsAt }], cost: { usd } }`; `percentUsed` was a whole number, `resetsAt` an ISO string; before the first request `context` holds only `window` (no `percent`) (live 2.1.332).
- After the main turn ended (its `turn.complete` settled) while a background subagent kept calling the API, a `$.clock.every(10_000, ...)` timer armed in `session.start` kept firing for the whole 8-minute run: 44 ticks, intervals 10.0 s (28), 12.3-12.4 s (3) and 13.6 s (12), none missing (live 2.1.332).
- The `five_hour` value moved without a turn completing: 9 at session start, 10 from about 2 minutes after the turn ended, 11 about 6.5 minutes after; each change was visible to the timer's `usage()` within one tick of the `session.measure` that announced it. `seven_day` moved 56 to 57 the same way (live 2.1.332).

## L3: `$.fs` from a `$.clock.every` callback

Outcome: passed

- `$.fs.exists` and `$.fs.read` called from a `$.clock.every` callback (out of any hook frame) ran without a permission dialog (interactive) and without a denial (`claude -p`), from all three locations (live 2.1.332):
  - a normal checkout (a scratch directory with `git init`): `.git/HEAD` found and read
  - its subdirectory two levels down: the walk tested `sub/deep/.git` and `sub/.git` (both absent), then found and read the root's `.git/HEAD`
  - a linked worktree root: `.git` is a file; reading it gave the `gitdir:` line, and reading `HEAD` under that path (in the main checkout's `.git/worktrees/`, outside the cwd) gave the branch
- No read failed in any run (interactive: 129 timer-side fs lines in the worktree session; headless: 6-12 per location) (live 2.1.332).
- `claude -p` exits normally with the timer still armed: exit 0, wall time 3.7-6.1 s for a one-word reply and 35-37 s for a turn with a 25 s background `sleep` (the timer fired 3 times during it) (live 2.1.332).

## L4: `session.measure`

Outcome: passed

- `claude plugin validate` and the preset's build accept a `session.measure` hook (no error naming it) (live 2.1.332).
- The event is the usage object (`context`, `rateLimits`, `cost`, without `startedAt`) plus `changed`, the list of the parts that changed, e.g. `["context", "rateLimits", "cost"]` (live 2.1.332).
- It is raised when usage changes, not on a fixed cadence: once at session start, at the end of a model request (context or cost changed) and when `rateLimits` changed; 5 events in an 8-minute interactive session with one turn and a background subagent, 4 in a 35 s headless run (live 2.1.332).
- `$.session.usage()` does not raise it: across 44 timer-side `usage()` calls no `session.measure` arrived during the call (live 2.1.332).
