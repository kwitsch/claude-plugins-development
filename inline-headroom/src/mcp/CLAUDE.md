# src/mcp/ — storage server notes

## Storage server

Invariants for `src/mcp/server.mts`:

- Node built-ins only (`node:` imports), no npm dependency, no bundling, one file.
- No static `node:sqlite` import. Only `--service` mode loads it via
  `await import("node:sqlite")`, so the front-end starts on any Node. Storage
  needs Node >= 22.13; Bun lacks `node:sqlite`, so there is no
  `bin/mjs-launch.sh`.
- All SQLite access happens in the `--service` process. It holds `storage.db`
  under `PRAGMA locking_mode=EXCLUSIVE` + `journal_mode=WAL` from start to exit.
  That lock is the host-wide election: a second service gets `SQLITE_BUSY` and
  exits 0. Only the lock holder unlinks a stale `storage.sock` and listens.
- Front-end stdout carries JSON-RPC only; the per-call debug log is gated by
  `MCP_HOOK_DEBUG`. The service never writes stdout; its stderr is
  `${CLAUDE_PLUGIN_DATA}/service.log`.
- Linux, macOS and WSL2 only: the service socket is a path-based Unix socket, so
  `callService` refuses on `win32` (native Windows is a spec non-goal; its
  `net.listen` would need a `\\.\pipe\` name). `storage_enabled` still defaults to
  `true` there; calls just return the "unsupported" error.
- Data lives only under `CLAUDE_PLUGIN_DATA` (`storage.db`, `storage.sock`,
  `service.log`). There is no fallback directory: an unset, blank or
  uninterpolated value refuses storage.
- `storage_enabled` is fail-closed (only the trimmed literal `"true"` enables)
  under the state-creating exception of `.claude/rules/plugin-userconfig.md`.
  Disabled means `tools/list` is `[]` and no file or process is created.
- The front-end retries `ENOENT`/`ECONNREFUSED`/`ECONNRESET` and a reply-less
  close (a service shutting down). Every op is idempotent, so a retry is safe
  (`kv_delete` may report `deleted:false` if the first attempt had applied;
  `stats_put` is an absolute upsert plus a date purge, so a replay is a no-op). The
  60 s failure cool-down gates only spawning: a live service is always tried first.
- The service shuts down (idle or SIGTERM) by closing its listener and draining
  accepted connections for at most 1 s before releasing the DB lock. A lost
  election logs one line to `service.log` only when no live service answers.
- `PROTOCOL` (an integer, now `2`) must be bumped on any op or schema change. A
  newer front-end SIGTERMs an older service; an older front-end refuses a newer
  one. A service whose plugin version (read from the generated `plugin.json`, never a literal)
  is older than the front-end's is also retired after answering, so a service-side
  fix without a `PROTOCOL` bump still takes effect. A pid is only signalled when
  `/proc/<pid>/cmdline` (where `/proc` exists) shows a `server.mjs --service`
  process. `MIGRATIONS` is append-only and additive once released: never edit,
  reorder or remove a released entry. `migrate` refuses a schema newer than the code.
- `execOp` is the single trust boundary, requests at most 2 MiB. Key checks
  apply to `kv_*` ops only: keys 1–512 chars, values at most 1 MiB serialized
  JSON. The stats ops validate real calendar days (`isDay`), the writer
  (`^[A-Za-z0-9_-]{1,64}$`) and counters (non-negative safe integers), and
  `stats_put` takes at most 31 rows. `stats_sum` reads its `SUM` as BigInt: a sum of
  safe-integer rows can pass 2**53, which a plain `node:sqlite` read rejects with
  `ERR_OUT_OF_RANGE` (it answers Numbers, so past 2**53 they are approximate).
  Accepted exposure: the model can call
  `stats_put` directly and overwrite any writer's row for a day, and since the
  purge is global and the caller picks `purgeBefore` (e.g. `9999-12-31`), it can
  delete every writer's rows. Same class as `kv_set`/`kv_delete`; the service is
  clock-free by design, so it cannot bound `purgeBefore`.
- Downgrade hazard: once a 0.3.0 service has migrated `storage.db` to schema v2,
  a 0.2.0 service refuses to start (`database schema v2 is newer than this plugin (v1); update inline-headroom`)
  and storage stays unavailable until the plugin is updated again. Intended
  append-only behaviour.

Key naming convention for consumers (documented, not enforced): a `<feature>/`
prefix, e.g. `notes/<sessionId>`. A feature that needs a table, `kv_list` or a
query adds a new `MIGRATIONS` entry and op plus a `PROTOCOL` bump.

`/headroom` counters live in the `stats` table (`MIGRATIONS[1]`), not in kv:
primary key `(day, writer)`; `day` is the mod's local calendar day `YYYY-MM-DD`
(computed in the mod, never by the service); `writer` is a random id per module
load (`WRITER` in `register.mts`); the counter columns are `steps`, `clamped`,
`cache_drops`, `input_tokens`, `cache_read_input_tokens` and
`cache_creation_input_tokens`, the order `STATS_KEYS` (`server.mjs`) and
`COUNTER_KEYS` (`policy.mjs`) share and a storage test pins. Rows hold absolute
totals and a writer only replaces its own, so concurrent sessions never share a
row and a hot reload (a new `WRITER`) never shrinks a stored total. The today /
7 days / 30 days rows are `stats_sum` from `windowStart(today, n)` on; every
`stats_put` deletes the rows before `windowStart(today, 30)`.

Deviation from `.claude/rules/hooks-mcp-server.md`: the `.mcp.json` key is
`storage`, not `<name>-hooks`, because this server backs no `mcp_tool` hook and
`hooks.json` never references it. `/headroom` persistence is the first mod-side
consumer.

Every mod-side storage call must be awaited by a running hook of this module
(live on 2.1.296): core routes `$.mcp.call` through `$.tool.call` and its
permission check, although the typings promise no prompt. A plugin's own hooks
see a call it raises only while one of its hooks runs; a call raised after the
hook returned (an unawaited chain, a `$.clock.every` callback) skips them, so
in `default` mode the user gets a permission dialog per call and a headless
session denies it. In-frame, the module's `tool.check` hook allows it
(`isOwnStorageCall`). Hence: `turn.complete` awaits its `stats_put`,
`command.run` awaits the first `stats_sum`, and a refresh tick only sets
`stale` and redraws, so the `ui.render` hook fetches.
