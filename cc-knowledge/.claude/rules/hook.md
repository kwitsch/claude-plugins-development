---
paths:
  - "src/hooks/**"
  - "hooks.template.json"
  - "tests/hook.test.ts"
  - "claude-tests/**"
---

# Reroute hook

A function-hooks module (rules `claude-code-hook-facts.md`, `tsdown-build.md` of the repository apply); no hook process, no MCP server. Reasons: [reroute-hook.md](../../../development/wiki/plugins/cc-knowledge/design/reroute-hook.md).

- `hooks.template.json` is exactly `{ "mod": "./src/hooks/register.ts" }` (generated `plugin/hooks/hooks.json`: `{"modules": ["./register.js"]}`); `src/hooks/register.ts` is the only hooks source (built to `plugin/hooks/register.js`).
- One `tool.call` hook with the matcher `{ tool: ["Agent", "Task"] }`. Any spelling of `claude-code-guide` (lowercased, separator runs collapsed to `-`) runs as `cc-knowledge:claude-code-expert`, other arguments kept; every other call passes unchanged. Loop-safe: the target is not a guide.
- Fail-open: no `.catch`, so a throwing hook is skipped and the guide runs un-rerouted. No permission override (`permissionDecision` is not set).
- Unit tests go through `claude-engine-vitest` against `src/hooks/register.ts` (the kit needs the any-of matcher (array leaf) that this plugin added to it); `claude-tests/register.test.ts` runs on the built `register.js` (`pnpm --filter cc-knowledge test:plugin`).
- After a change run `claude plugin validate cc-knowledge/plugin` (the static check is not in the kit): it lists `./register.js hooks: tool.call{tool=Agent|Task}`.
