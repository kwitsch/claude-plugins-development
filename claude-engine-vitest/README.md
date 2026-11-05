# claude-engine-vitest

A vitest stand-in for Claude Code's mod test kit `claude-code/testing`. The official kit exists only inside the `claude` binary and runs under `claude plugin test`. This package runs the same kind of test under plain vitest, against a plugin's built hooks module. It mirrors the kit's API and semantics ([Test a mod](https://code.claude.com/docs/en/plugins/mods/test.md), [Mods reference](https://code.claude.com/docs/en/plugins/mods/reference.md)), so you port a kit test by changing its imports. It is a workspace package, not a plugin (it has no `plugin.json`). Its only dependency is vitest, as a peer.

## API

```js
import { expect } from "vitest";
import { createKit } from "claude-engine-vitest";

const { test, mock } = createKit({ module: new URL("../plugin/hooks/register.mjs", import.meta.url), plugin: "my-mod", options: {} });

test("name", { options: { flag: false }, plugins: [{ name: "helper", register(on) {} }], timeoutMs: 5000 }, async ($, on) => {
  on("tool.call", () => ({ result: "ok" })); // a stub: register every one before the first call on $
  await $.tool.call({ tool: "Bash", command: "ls" });
});
```

- `createKit({ module, plugin, options?, tier? })` returns `{ test, mock }`. Each test imports a fresh module instance (a cache-busting query) at its first call on `$`, then calls `register(on, options)`. `options` is the kit's `options` with the test's own `options` merged over it.
- `test(name, [opts], body)` wraps vitest's `test`. `opts` takes `options`, `plugins` (inline `{ name, tier?, register }` mods, loaded after the module under test) and `timeoutMs` (5000 ms by default).
- `on(event, [matcher], stub)` registers a stub beneath every plugin. A stub for a mods API call returns `{ value }` or `{ deny }`. A stub for an event returns that event's result, and a `turn.step` stub is an async generator. Registering after the first `$` call throws `on("<event>") after the test first called $`.
- `$.<ns>.<event>(input)` fires the event as Claude Code (`next.origin` is `{ plugin: "engine", tier: "core" }`) through every plugin's hooks, then the stubs, then the kit's bottom, which throws `no implementation for <event>`. `$.turn.step` returns the stream. A mods API call such as `$.ui.close` cannot be fired from a test.
- A mod's `$.<ns>.<method>(...)` fires the event `<ns>.<method>` with the positional arguments mapped to input fields as the reference lists them (`$.mcp.call(server, tool, args)` is `{ server, tool, args }`). The event runs through the hooks of the plugins at or above the caller, skipping the calling hook, and then the stubs. It resolves to the `value` or rejects with the `deny`. The kit answers `ui.invalidate` itself by redrawing every mounted site, and `session.append` by echoing `{ message, uuid }`. `ui.resolve` returns element factories that build plain `{ type, props, children }` data.
- A hook that throws is skipped and the chain goes on beneath it. A failing test's error lists every skipped hook and every rejected mods API call under `the engine reported:`. An assertion that fails inside a hook or a stub fails the test, and so does a stub for a mods API call that returns neither `{ value }` nor `{ deny }`.
- `$.ui.mount(e)` draws a render site through the `ui.render` chain. It returns `{ find, findAll, press, input, select, unmount }`, and `find` takes `{ type, text, key }`, where a string `text` matches as a substring. `$.ui.press({ plugin, key, requestId? })` presses a drawn `Button`.
- `mock.clock(on, { now })` returns `{ now, advance, set, settle, sleep }`. `$.clock.every` and `$.clock.after` dispatch one wait per period, so a timer fires exactly on its period boundary. `mock.store(on, entries)`, `mock.env(on, vars)` and `mock.session(on)` (`appended()`) are also available.

## Deviations from the official kit

- Assertions come from vitest's `expect`, and there is no `tier()` export (pass `tier` to `createKit`). `describe` is vitest's.
- `options` are not filled from the manifest's `userConfig` defaults. Pass them in `createKit` or per test.
- Not implemented: `$.state`, `$.classic.*` beyond plain event dispatch, `plugin.register` refusals, `engine.create`, `next.to`, `next.budget`, `on("!x")` patterns, minting `tool_use_id`, and the hook time limits (a held clock wait is never let go). A `.catch` handler's result replaces a failing hook's result. Its exact semantics in the engine are unverified.
- Matchers compare fields with `===`, and nested objects field by field. A redraw is not scoped to the invalidating hook's matcher: every mounted site redraws.
- `settle` waits until a full event-loop turn passes with no dispatch, render or clock activity. Work that never yields to the event loop is not awaited.

## Porting a kit test

1. Replace `import { expect, mock, test } from "claude-code/testing"` with `import { expect } from "vitest"`, `import { createKit } from "claude-engine-vitest"` and `const { test, mock } = createKit({ module, plugin })`.
2. Point relative imports of the mod's own files at the built `plugin/` output, and drop the TypeScript types (`*.test.mjs`).
