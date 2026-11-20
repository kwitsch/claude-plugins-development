# The reroute hook (do not "fix" without reading this)

Why the `claude-code-guide` reroute is one function-hooks module and how it fails.

## Design

- A mods function-hooks module, no hook process and no MCP server (`plugin/hooks/hooks.json` is `{"modules": ["./register.js"]}`). One `tool.call` hook with the matcher `{ tool: ["Agent", "Task"] }` calls `next` with `subagent_type` rewritten by `rerouteType`; every other call passes as is.
- Any spelling of `claude-code-guide` (lowercased, separator runs collapsed to `-`, trimmed) runs as `cc-knowledge:claude-code-expert`, other arguments kept. Loop-safe: the target is not a guide. Main loop and subagents alike (docs).
- Fail-open: no `.catch`, so a throwing hook is skipped and the guide runs un-rerouted, as the former `mcp_tool` hook did when its server was down (`claude plugin validate` warns "gating hook without .catch" by design).
- No permission override: the former hook's `permissionDecision: "allow"` only carried its `updatedInput`. A mods rewrite needs none, and Agent calls raise no prompt in `default` mode (live 2.1.302).
- Renamed from `claude-code-knowledge` in 2.0.0: Claude Code 2.1.302 reserves third-party plugin names starting with `claude-`. Installs keyed `claude-code-knowledge@kwitsch-plugins` must be replaced by `cc-knowledge@kwitsch-plugins`; skill and agent namespaces moved from `claude-code-knowledge:` to `cc-knowledge:`.

## In this repository

- The source is one file, `src/hooks/register.ts` (the former `reroute.mjs` helper, 20 lines, was folded in), built by tsdown to `plugin/hooks/register.js` since 2.2.1 ([tsdown-build.md](../../../../../.claude/rules/tsdown-build.md)).
- A plugin whose hooks module is one small file stays a single `register.ts`, so there is no `lib.mjs` and no bundle step. Rejected: keeping `reroute.ts` as a helper, which would have forced the bundle for 20 lines.
- The tests go through the kit. The kit matched `tool: ["Agent", "Task"]` against `===` and never ran the hook, so the kit gained an any-of rule for array leaves in matchers ([test-kit-vs-engine.md](../../../facts/test-kit-vs-engine.md)). A test that passes only because the hook never ran is the trap: the "other types pass untouched" rows alone would have stayed green.
- Live (2.1.328, headless, `--setting-sources project`): an Agent call for `claude-code-guide` ran as `source=agent:custom:cc-knowledge:claude-code-expert` in the debug log.
