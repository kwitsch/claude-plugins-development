---
paths:
  - "src/hooks/**"
  - "plugin/hooks/**"
  - "tests/hook.test.ts"
---

# Reroute hook

A function-hooks module (rules `claude-code-hook-facts.md`, `hooks-lib-bundle.md` of the repository apply); no hook process, no MCP server. Reasons: [reroute-hook.md](../../../development/wiki/plugins/cc-knowledge/design/reroute-hook.md).

- `plugin/hooks/hooks.json` is exactly `{"modules": ["./register.mjs"]}`; `src/hooks/register.ts` is the only hooks source (the reroute logic is small and stays in it: no helper files, no `lib.mjs`, no `pluginBuild.bundleHooksLib`).
- One `tool.call` hook with the matcher `{ tool: ["Agent", "Task"] }`. Any spelling of `claude-code-guide` (lowercased, separator runs collapsed to `-`) runs as `cc-knowledge:claude-code-expert`, other arguments kept; every other call passes unchanged. Loop-safe: the target is not a guide.
- Fail-open: no `.catch`, so a throwing hook is skipped and the guide runs un-rerouted. No permission override (`permissionDecision` is not set).
- Tests go through `claude-engine-vitest` against `plugin/hooks/register.mjs`; the kit needs the any-of matcher (array leaf) that this plugin added to it.
- After a change run `claude plugin validate cc-knowledge/plugin` (the static check is not in the kit): it lists `./register.mjs hooks: tool.call{tool=Agent|Task}`.
