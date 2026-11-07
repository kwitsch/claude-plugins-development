# CLAUDE.md — inline-headroom

Mods-API plugin: one TypeScript function-hooks module (no skills, agents or command hooks), the `/headroom` stats
command, the compression levers' `headroom_retrieve` tool, and a host-wide SQLite storage MCP server in which the mod
persists `/headroom` counters.

## Toggles

The full list with titles and descriptions is `package.json` `claudePlugin.userConfig`. Conventions:

- Every lever (effort routing, the cache aligner and each compression lever) sits behind its own boolean `*_enabled`
  toggle, `default: true`; only the literal `false` disables.
- State-creating toggles are fail-closed: `storage_enabled` enables only on the literal `true`.
- Infrastructure with no behaviour of its own gets no toggle (the content router); each compressor brings its own.
- Dependent toggles act only while their parent is on: `subagent_effort_routing_enabled` needs
  `effort_routing_enabled`; `subagent_compression_enabled` needs at least one compression lever.
  `tag_protector_enabled` only narrows what the compression levers rewrite.

## Layout

`package.json` follows the repo layout (root `CLAUDE.md`): it is the only manifest source, with `userConfig` under its
`claudePlugin` key. `pnpm build` compiles `src/**/*.mts` to `plugin/**/*.mjs` (minified; `plugin/hooks/` unmangled
and uncompressed) and generates `plugin/.claude-plugin/plugin.json` from `package.json`.

- `src/hooks/register.mts` → `plugin/hooks/register.mjs`: every hook and every `$` use.
- `src/hooks/policy.mts` → `plugin/hooks/policy.mjs`: pure, zero-dep logic with no clock reads (time comes in as
  arguments) and no `$`; holds the content router and every compression lever.
- `src/mcp/server.mts` → `plugin/mcp/server.mjs`: the storage server, registered by the hand-written
  `plugin/.mcp.json`.

## Where the details live

Path-scoped rules in `.claude/rules/` load when you work on matching files:

- `register-hooks.md` (`register.mts`, its test, `hooks.json`): engine pitfalls, in-frame storage calls, the
  compression wiring shared by every lever, the effort-routing caveat.
- `policy-smartcrusher.md`, `policy-dedup-elider.md`, `policy-compressors.md`, `policy-text-tags.md`,
  `policy-router.md` (`policy.mts`, its test): each lever's port notes and deviations from upstream headroom.
- `storage-server.md` (`src/mcp/`, `.mcp.json`, the storage test): protocol, service singleton, schema and
  migrations, the `/headroom` counters table.

`docs/claude-code-verification.md` (not auto-loaded) holds the engine-shape evidence and the open live-check list.
`docs/linux-token-efficiency-concepts.md` (not auto-loaded) records the deprecated linux-token-efficiency plugin's
mechanisms (rtk Bash rewrite, context-mode deny-steering, codebase-memory graph hooks, terse output style) for
future ports.

## Tests

```bash
# CI (Node 24): workspace oxlint, build, then register, policy, storage server and manifest tests (vitest, tests/*.test.mts) against plugin/
pnpm exec oxlint && pnpm --filter inline-headroom build && pnpm --filter inline-headroom test
claude plugin validate inline-headroom/plugin
```
