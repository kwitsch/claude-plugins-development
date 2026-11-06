---
paths:
  - "scripts/hooks.mts"
  - "plugin/hooks/hooks.json"
  - "src/mcp/hook-inputs.d.mts"
  - "src/mcp/server.mts"
  - "tests/hooks-script.test.mts"
---

# Hook-input contract (`scripts/hooks.mts` → `src/mcp/hook-inputs.d.mts`)

- `plugin/hooks/hooks.json` is hand-written and is the hook-input contract. `scripts/hooks.mts` validates it:
  `mcp_tool` hooks, plus `command` hooks (non-empty `command`, timeout checked, no input, no generated types);
  `server` = `plugin:dprint:<.mcp.json key>`; every `${…}` placeholder a real input field of its event and, for
  `Write`/`Edit` matchers, of those tools; one input shape per tool. It validates only the `hooks` map, not `modules`.
- It generates `src/mcp/hook-inputs.d.mts` (one interface per tool plus the `HookInputs` map) from the `input`
  templates. `server.mts` types its tool table by `HookInputs`, so a tool missing on either side is a compile error.
- Never edit the `.d.mts` by hand: `pnpm build` regenerates it, and `pnpm --filter dprint lint` runs
  `scripts/hooks.mts --check`, which fails while it is stale.
- A new hook event needs its input fields in `EVENT_FIELDS` in `scripts/hooks.mts`.
