---
paths:
  - "src/hooks/register.mts"
  - "tests/register.test.mts"
  - "plugin/hooks/hooks.json"
---

# `register.mts`: hooks, `$` use and engine pitfalls

`plugin/hooks/hooks.json` (hand-written) is exactly `{"modules": ["./register.mjs"]}`. `src/hooks/register.mts` holds
every hook and every `$` use and imports `./policy.mjs`. Tested by `tests/register.test.mts` (kit-style tests on the
workspace package `claude-engine-vitest`). Evidence for the shapes below: `docs/claude-code-verification.md`.

## Engine pitfalls (change how the code must be written)

- No `claude-code` type import: the used `$` members and events are typed structurally at the top of the file. No
  `any`, no `import()` (a module holding `import()` does not load).
- `policy.mts` must never reference `$`: the engine rejects passing the mods API into functions imported from another
  file. It also rejects `$.<noun>` as a bare value (bound, passed or read), so same-file helpers take the whole `$`
  typed `Engine` (`claude plugin validate` lists their calls as `$.mcp.call (via callStorage)`).
- One hook per event without a matcher (`registered twice without a matcher` fails validate and test). Hence:
  `turn.complete` has one hook (storage write, subagent error cleanup, a finished agent's dedup-corpus reset);
  `session.compact` one (dedup reset); `tool.call` one (effort-error observer and the `headroom_retrieve` answer);
  `session.append` exactly one, with the matcher `{ door: "tool-result" }`, running every compression lever.
- `tool.call` failure is `isError: true` or `deny: string`; there is no `exitCode`. An MCP tool's `tool.call` resolves
  `{ ref, result, text }` with `result` the content-block array itself, not `{ content: [...] }` (that is
  `$.mcp.call`'s shape).
- `$.mcp.connect(key)` takes the bare `.mcp.json` key (`"storage"`), never rejects, and resolves
  `{ isConnected: true, server }` (the namespaced name `$.mcp.call` takes) or `{ isConnected: false, reason, message }`.
  `structuredContent` is not forwarded for a tool without `outputSchema`, so `callStorage` reads the JSON text block.
- `turn.step` `usage` may be `null`; `command.run` returning `{}` prints no row and records no model context.
- `cc-plugin-sec-default` skips every user-tier `prompt.compose`/`prompt.section`/`prompt.context` hook, so the mod
  registers no `prompt.compose` hook. Since 2.1.310 core reports each skipped hook once per session as a user-visible
  notice; the one for `tool.check` (the mod's own storage call, re-dispatched beneath the user tier) is unavoidable
  while the mod writes storage and is documented in the README.

## Storage calls must run in-frame

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

## Compression wiring (shared by every lever)

- One `session.append` hook with the matcher `{ door: "tool-result" }`,
  registered while any compression lever is on (`compressOn` in
  `register.mts`), rewrites each tool-result row before it is
  first stored and sent, so the model, the transcript file and every later
  request read one form (prompt-cache safe). `rewriteToolResults` (pure, in
  `policy.mjs`) labels each text with `detectContentType`, runs that type's
  `ROUTES` steps (crush then elide for `json_array`, config then elide for
  `structured_config`, extract then elide on the extraction for `html`, log,
  logfold then elide for `build`, search, searchfold then elide for `search`,
  diff, difffold then elide for `diff`, split, textcrush, textfold then elide
  for `text`, elide alone for `tabular` and `source_code`), then deduplicates a
  single-text result (see `## Content router` (`policy-router.md`)).
- Gates, each passing the row through with `next(e)`: `retrieveReady` (this
  module load registered the tool under `RETRIEVE_TOOL`; a marker must never
  name a missing tool), `origin.kind === "tool"`, and a subagent row
  (`e.agentId`) only while `subagent_compression_enabled` is on.
- Protected rows are never rewritten: a block with `is_error === true`, and
  every block of a `headroom_retrieve` row (matched by tool name in any
  namespace: the full name, the bare name or another server's, since a row's
  `origin.tool` for a plugin-registered tool is not live-verified) or an
  `mcp__plugin_inline-headroom_storage__*` row (a `kv_get` → edit → `kv_set`
  would write the loss back to `storage.db`). Dedup still indexes them as
  originals.
- `wantsQuery` gates the `$.session.messages()` fetch (`{ agentId }` for a
  subagent row; a `{ deny }` means an empty query), so the transcript is read
  only for a row holding a JSON document the crusher may rewrite or, while the
  search compressor, the diff compressor, the text crusher or the relevance
  split is on, any non-Read text of 300+ characters (`register.mts` passes its
  `levers` as `wantsQuery`'s third argument); a failed fetch compresses without
  query signals (the relevance split then declines).
- `next` is called exactly once on every path and its answer is returned
  unchanged. Any throw before it (the fetch, the pipeline) passes the row
  through unchanged (fail open), and a throw inside `rewriteToolResults` first
  empties that conversation's dedup corpus (a block indexed before the throw
  belongs to a row stored as made); a rejection from `next` itself empties the
  corpus the same way and propagates (no trigger is known: the kit skips a
  throwing hook beneath instead of rejecting). A downstream hook that replaces
  or drops the row after `next` resolves is not detected.
- Every dropped original goes to an in-memory `Map` through `storeOffloaded`
  (1000 entries and `CCR_MAX_CHARS` characters each, oldest evicted, no TTL;
  upstream caps by count only), in two stores so dedup churn never evicts a
  sole copy: `offloaded` holds the crusher's, the elider's, the config
  compressor's, the HTML extractor's, the log, search and diff compressors',
  the text crusher's and the relevance split's originals, which exist nowhere
  else, and `folded` holds dedup runs, whose earlier copy is still
  in the transcript until a compaction. `storeOffloaded` never evicts an entry
  of the batch it was just given (a row's markers always resolve, even when it
  folds more than 1000 runs), so a store may sit over a cap until its next call
  with entries.
  Both stores are module memory only: a mod reload (an options change, a plugin
  update) or a resumed session loses every original while the transcript keeps
  the markers, and `headroom_retrieve` then denies the hash. Persisting them in
  the storage server is deferred (a `kv_set` value is capped at 1 MiB, and each
  write would be an awaited storage call inside the append hook).
- The module's one matcher-less `tool.call` hook (registered while
  `effort_routing_enabled` or any compression lever is on) observes effort
  errors and answers `mcp__inline-headroom__headroom_retrieve` itself from
  `offloaded`, then `folded` (`session.start` registers the tool); a miss is a
  `{ deny }`, which the effort observer counts as a failure. `retrieveKey`
  accepts the bare hash, `hash=H` and a whole `<<ccr:H …>>` marker, and drops
  the closing `]` or `>>` of a copied marker (a dedup pointer and an elider line
  end in `]`), because the tool's description cites the marker forms.
- Model-only holds structurally: a tool-result row answers a `tool_use` block
  of the model's response, and a `session.append` rewrite never changes what a
  plugin's `$.tool.call` resolves to.
- The compression tables' counters (`smart crusher`, `dedup`, `line elider`,
  `compaction` and every later lever's) are session-only and reset on
  `session.end`. Persisting them needs new `stats` columns, a `MIGRATIONS`
  entry and a `PROTOCOL` 2 → 3 bump, so it is deferred.

## Effort-routing caveat

Upstream headroom removed effort routing after measurement (~$0.0007 saved per
mechanical turn vs ~$0.011 cache re-write per effort switch). `effort_routing_enabled`
still defaults to `true` per the toggle convention in the plugin `CLAUDE.md`; the
`effort_routing_enabled` toggle, the per-step `cache drop` log and the
`/headroom` drop count are how a user measures whether it pays off. The
`cache drop` log and the drop count cover the main loop only.

`subagent_effort_routing_enabled` (default `true`, active only with
`effort_routing_enabled`) applies the same clamp per `agentId`. It is a separate
toggle (user decision) because the clamp overrides deliberately set effort
(agent frontmatter `effort`, Agent tool `effort` param, Workflow `effort`
option) and each subagent pays its own cache re-write on the switch, which
`/headroom` does not measure. Its own `subagents` row lives in memory only;
its steps and clamps also go into the persisted `steps` and `clamped` columns
(no schema change), so the storage rows count main-loop and subagent steps
while the `session` row stays main-loop. An agent's `turn.complete` writes the
pending totals too, so a background agent's steps need no main-loop turn.
