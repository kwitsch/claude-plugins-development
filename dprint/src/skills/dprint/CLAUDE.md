# dprint skill scripts

Built to `plugin/skills/dprint/`, next to the hand-written `SKILL.md`, the `*.reference.md` contracts and
`dprint-plugins.json`:

- `check-dprint.mts`: dprint detection and minimum-version check (contract: `check-dprint.reference.md`).
- `scan-plugins.mts`: read-only scan of the project's file types against its dprint config, reads
  `dprint-plugins.json` (contract: `scan-plugins.reference.md`).
- `run-dprint.mts`: check/fmt dispatcher with the not-set-up gate (contract: `run-dprint.reference.md`).
- Shared modules (also imported by `src/mcp/`): `config-names.mts` (the six dprint config file names in
  `CONFIG_NAMES`), `find-config.mts`, `find-dprint.mts`.

## Resolution (single source; referenced from `src/mcp/` and `src/hooks/`)

- `findDprint` (`find-dprint.mts`, async): `PATH`, then `~/.dprint/bin`, then `npx --yes dprint` (async probe, a
  failure re-probed after 30 s). `dprintArgv` builds the spawn arguments from the returned argv prefix.
- `findConfig` (`find-config.mts`): first of `CONFIG_NAMES` in a directory or its ancestors, never above the
  git/worktree root (nearest dir holding `.git`). Used by `run-dprint`, `scan-plugins` and `mcp/format`.
