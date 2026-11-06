# CLAUDE.md — inline-headroom

Mods-API plugin: one TypeScript function-hooks module, no
skills/agents/command hooks. Thirteen levers, each behind a boolean
`userConfig` toggle (`effort_routing_enabled`, `cache_aligner_enabled`,
`smart_crusher_enabled`, `lossless_compaction_enabled`,
`cross_turn_dedup_enabled`, `dense_line_elider_enabled`,
`config_compressor_enabled`, `html_extractor_enabled`,
`log_compressor_enabled`, `search_compressor_enabled`,
`diff_compressor_enabled`, `text_crusher_enabled`, `relevance_split_enabled`),
plus `subagent_effort_routing_enabled`, which extends effort routing to subagent
and Workflow-agent steps and is active only while `effort_routing_enabled` is
on, `subagent_compression_enabled`, which extends the eleven compression levers
to subagent and Workflow-agent tool results and is active only while one of
them is on, and `tag_protector_enabled`, which keeps custom workflow tags whole
across the compression levers (all sixteen `default: true`, only literal
`false` disables; `storage_enabled`, the seventeenth `userConfig` key, is
fail-closed), plus the
`/headroom` stats command and the compression levers' `headroom_retrieve` tool.
It also ships a host-wide SQLite storage MCP server behind the fail-closed
`storage_enabled` toggle (see `src/mcp/CLAUDE.md`); the mod persists
`/headroom` counters in it.

## Layout

`package.json` follows the repo layout (root `CLAUDE.md`): it is the only manifest source, with `userConfig` under its `claudePlugin` key.
`pnpm build` compiles `src/**/*.mts` to `plugin/**/*.mjs` (minified; `plugin/hooks/` unmangled and uncompressed), and generates `plugin/.claude-plugin/plugin.json` from `package.json`.

- `plugin/.mcp.json` (hand-written) — registers `src/mcp/server.mts` directly (no wrapper, no args) under
  the key `storage`, with env `INLINE_HEADROOM_STORAGE_ENABLED` =
  `${user_config.storage_enabled}`. `CLAUDE_PLUGIN_DATA` gets no `env` entry:
  Claude Code exports it to stdio MCP servers.
- `src/mcp/server.mts` → `plugin/mcp/server.mjs` — the storage server: one zero-dep executable module
  (`#!/usr/bin/env node`, mode 0755 set by the build) with two modes, the per-session stdio MCP
  front-end and the detached `--service <dataDir>` singleton. Its pure exports
  (`isStorageEnabled`, `resolveStorage`, `migrate`, `execOp`, `PROTOCOL`,
  `MIGRATIONS`) are tested by `tests/storage.test.mts`; an
  `isMainModule()` guard keeps that import free of side effects.
- `plugin/hooks/hooks.json` (hand-written) — exactly `{"modules": ["./register.mjs"]}`.
- `src/hooks/register.mts` → `plugin/hooks/register.mjs` — every hook and every `$` use. No `claude-code`
  type import: the used `$` members and events are typed structurally at the top of the file. No `any`, no
  `import()` (a module holding `import()` does not load). It imports `./policy.mjs`. Tested by
  `tests/register.test.mts` (kit-style tests on the workspace package `claude-engine-vitest`).
- `src/hooks/policy.mts` → `plugin/hooks/policy.mjs` — pure, zero-dep logic with no clock reads
  (time comes in as arguments). It must never reference `$`: the engine rejects
  passing the mods API into functions imported from another file. It also
  rejects `$.<noun>` as a bare value (bound, passed or read), so same-file
  helpers in `register.mts` take the whole `$` typed `Engine`.
  Tested by `tests/policy.test.mts`. It also holds the content router and
  the SmartCrusher (with its lossless compaction stage), cross-turn dedup,
  dense line elider, config compressor, HTML extractor, log compressor, search
  compressor, diff compressor, text crusher and relevance split ports, and the
  tag protector (see their sections in `src/hooks/CLAUDE.md`).

## Tests

```bash
# CI (Node 24): workspace oxlint, build, then register, policy, storage server and manifest tests (vitest, tests/*.test.mts) against plugin/
pnpm exec oxlint && pnpm --filter inline-headroom build && pnpm --filter inline-headroom test
claude plugin validate inline-headroom/plugin
```

`storage.test.mts` needs `node:sqlite` and spawns processes. Its cleanup SIGTERMs every `--service` process for
its temp data dir, so no daemon outlives the suite.

## Where the details live

Subdirectory `CLAUDE.md` files load on demand when files there are read or edited:

- `src/mcp/CLAUDE.md` — the storage server (`src/mcp/server.mts`, `tests/storage.test.mts`): protocol, service singleton, schema/migrations, permission rules.
- `src/hooks/CLAUDE.md` — every lever's port notes (`src/hooks/policy.mts`: SmartCrusher through content router, tag protector) and the hook-API notes for `src/hooks/register.mts` (verified Claude Code shapes, not-yet-live-verified list, effort-routing caveat).
