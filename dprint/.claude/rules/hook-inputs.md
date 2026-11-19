---
paths:
  - "scripts/hooks.ts"
  - "plugin/hooks/hooks.json"
  - "src/mcp/hook-inputs.d.ts"
  - "src/mcp/server.ts"
  - "tests/hooks-script.test.ts"
---

# Hook-input contract (`scripts/hooks.ts` → `src/mcp/hook-inputs.d.ts`)

- `plugin/hooks/hooks.json` is hand-written and is the hook-input contract. `scripts/hooks.ts` validates it:
  `mcp_tool` hooks, plus `command` hooks (non-empty `command`, timeout checked, no input, no generated types);
  `server` = `plugin:dprint:<.mcp.json key>`; every `${…}` placeholder a real input field of its event and, for
  `Write`/`Edit` matchers, of those tools; one input shape per tool. It validates only the `hooks` map, not `modules`.
- It generates `src/mcp/hook-inputs.d.ts` (one interface per tool plus the `HookInputs` map) from the `input`
  templates. `server.ts` types its tool table by `HookInputs`, so a tool missing on either side is a compile error.
- Never edit the `.d.ts` by hand: `pnpm build` regenerates it, and `pnpm --filter dprint lint` runs
  `scripts/hooks.ts --check`, which fails while it is stale.
- A new hook event needs its input fields in `EVENT_FIELDS` in `scripts/hooks.ts`.
