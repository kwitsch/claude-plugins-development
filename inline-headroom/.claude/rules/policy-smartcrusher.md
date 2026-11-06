---
paths:
  - "src/hooks/policy.mts"
  - "tests/policy.test.mts"
---

# SmartCrusher and lossless compaction (`policy.mts`)

## SmartCrusher

A port of upstream headroom's dict-array lossy path
(`crates/headroom-core/src/transforms/smart_crusher/`, read 2026-10-10) into
`src/hooks/policy.mts`: adaptive K (`computeOptimalK`: simhash diversity plus the
Kneedle knee of the bigram coverage curve, 3 to 15 rows), the analyzer (field
stats, pattern, the crushability gate and the strategy), the four planners
(smart sample, top N, cluster sample, time series), the anchor selector, the
must-keep sets (error keywords, structural outliers, numeric anomalies, change
points), query anchors with BM25-boosted relevance (`crushQuery` builds the
query from `$.session.messages()`), and prioritization. Upstream's defaults are
module constants, with no config object: 5 rows to analyze, at most 15 kept,
variance threshold 2, relevance threshold 0.3, depth 50, and `CRUSH_MIN_CHARS`
800 (200 tokens at 4 chars per token).

Deviations from upstream:

- A pure-JS two-lane `hash64` replaces MD5 (simhash grams) and SHA-256 (the
  12-hex CCR hash); dedup and cluster keys are the sorted-key JSON and the
  50-code-point prefix themselves. `node:crypto` and `node:zlib` stay out: a
  mods module is not known to load node built-ins, and a refused import would
  unload every lever.
- `compute_optimal_k`'s zlib tier is skipped (it can only raise K by 20%).
- A document holding a number whose double prints as another decimal (more than
  17 significant digits, an integer beyond 2^53, an overflow to `Infinity`), a
  `-0` or a duplicate object key is passed through (`JSON.parse` then
  `JSON.stringify` would corrupt it; `isLossy` scans the text for each). Number
  lexemes that survive are re-rendered (`1.50` → `1.5`), and integer-like object
  keys come first (a JS object rule).
- The tool-digest marker is omitted: the mod rewrites each result once, at
  `session.append`.
- Candidates are tool_result texts as the model reads them, from any tool; the
  Bash record guards are dropped because each guarded case renders text that is
  not one JSON document, so the whole-document parse rejects it. Read results
  carry `N\t` line numbers and never parse as JSON (nor as HTML: see `## Content router` (`policy-router.md`)). A row carries no `context`, so the
  former `context` carry-over is moot, and a subagent row's query comes from
  `$.session.messages({ agentId })`. The crusher's thresholds and algorithm are
  unchanged.
- A query token or anchor found in more than half the rows is ignored
  (`isSelective`); upstream counts it, so a key name in the query marks every
  row relevant and the crush degrades to the head rows.
- A document that loses no row passes through with its exact bytes; upstream
  also minifies a pretty-printed one.
- `crushQuery` counts only user messages with text toward its last five: a
  Claude Code tool result is a user message with empty text, so upstream's
  count would drop the user's request after five tool calls.
- `crushQuery` keeps at most `CRUSH_QUERY_INPUT_CHARS` (16,384) characters of
  assistant tool-call input JSON in all, newest first; upstream has no cap. A
  subagent has one user message, so its walk would otherwise stringify every
  input back to the agent's start on each JSON result (O(n²) over its life).
- JS regex `\b` is ASCII-only where Rust's is Unicode, and lengths count UTF-16
  code units where upstream counts UTF-8 bytes (length score, quoted anchors).
- Deferred: opaque-blob CCR, TOIN / `preserve_fields`, `factor_out_constants`,
  `include_summaries`, tabular ingest (CSV text turned into records: upstream's
  own lossless-first stage makes it a no-op on CSV, and the markdown and
  fixed-width tables it would also take need the omitted detector branches
  plus a CSV parser) and the embedding scorer (stubbed upstream too).

Default-behaviour change of this lever (0.7.0): with
`lossless_compaction_enabled` on (the default) the lossless table of
`## Lossless compaction` is tried first and usually wins on a uniform dict
array, so the model sees a schema table (a JSON string holding `[N]{…}` and CSV
rows where the array stood) instead of sampled rows plus a `_ccr_dropped`
sentinel, and nothing is dropped. The crushed text is still one compact JSON
line, so what dedup and the elider see does not change.
`lossless_compaction_enabled: false` restores the lossy-only output.

### String, number and mixed-array crushers

The remaining arms of upstream `process_value` (`crushers.rs`
`crush_string_array`, `crush_number_array` and `compute_k_split`, and
`crusher.rs` `classify_array`, `crush_mixed_array` and
`append_scalar_drop_sentinel`, read 2026-10-11 at 976aa71), as
`crushStringArray`, `crushNumberArray`, `crushMixedArray` and
`numberChangePoints`. They are part of `smart_crusher_enabled` (arms of one
upstream component behind one toggle), run only with the lossy stage, and
count their dropped items in the `smart crusher` table's `dropped`.

Ported verbatim:

- `classify_array`: an array of one JSON type is a dict, string or number
  array; bool-only, nested-only and empty arrays are recursed into; any mix of
  types, or any null, is mixed. Only arrays of 5 or more items are classified.
- `compute_k_split` with the BUG #4 clamp: the adaptive K, its first 30% and
  last 15% (at least 1 each, rounded half to even), clamped so both fit in K.
- The string crusher: 8 or fewer items pass through; error-keyword items,
  length anomalies (code points more than 2 sample σ from the mean) and the
  first and last K always stay; a stride tops the kept set up to K plus the
  errors and anomalies, skipping repeats of a kept string; the order is kept.
- The number crusher: outliers (more than 2 sample σ), change points (more
  than 10 numbers, window 5, the mean of the 5 before against the 5 from each
  index, more than 2σ apart, no spacing rule) and the first and last K stay; a
  stride tops the kept set up to K plus the outliers.
- The mixed crusher: groups by JSON type in first-seen order, a group under 5
  items kept whole; the dict group through the dict path with the caller's
  stages (a winning table keeps the group whole, dropped rows matched back by
  sorted-key JSON), the string group keeping every copy of a kept string, the
  number group its first and last K plus its outliers, every other group whole.
- A string, number or mixed array is never descended into, whether or not it
  lost items; one that lost items ends with the string sentinel
  `… N more items <<ccr:HASH N_items_offloaded>>` (U+2026), its compact JSON
  stored under the hash. Without the lossy stage (`lossless_only`) such arrays
  stay whole.

Deviations:

- Number items feed `compute_k_split` as `String(n)` where upstream keeps the
  original lexeme (`1.0`, `1e21` spell differently), a minor simhash
  difference.
- The strategy/debug string (and its percentile logic) is not ported: nothing
  reads it.
- `numberChangePoints` is its own helper: the dict analyzer's `changePoints`
  needs 10 values and keeps a point only more than 5 past the previous one,
  which upstream's number crusher does not.

Behaviour change of this lever (0.7.0): string, number and mixed arrays of 9
or more items inside a crushable document now lose items behind the sentinel
above, and string, number and mixed arrays of 5 to 8 items are no longer
descended into (a dict array nested in one stays whole), as upstream.

Behaviour change of this lever (0.7.0): with `tag_protector_enabled` on (the
default) a JSON text holding a custom tag (see `## Tag protector` (`policy-text-tags.md`)) runs without
the lossy stage, so no row or item of it is dropped; lossless compaction may
still rewrite it, every string staying verbatim in a cell.

## Lossless compaction

A port of upstream headroom's lossless-first SmartCrusher stage
(`crates/headroom-core/src/transforms/smart_crusher/compaction/compactor.rs`,
`formatter.rs` and `classifier.rs`, and `crusher.rs`
`crush_array_with_source`, read 2026-10-11 at 976aa71) into
`src/hooks/policy.mts` as `compactRows`, `formatCsvSchema` and `compactionJson`,
run by `crushDictArray` inside the `crush` step, before the lossy path. It has
its own toggle, `lossless_compaction_enabled`, and its own `compaction` table
(`arrays`, `saved`). With the SmartCrusher's toggle it maps onto upstream's
configurations: both on is `SmartCrusher::new` (the default), the crusher alone
is `without_compaction`, and compaction alone is `lossless_only`.

Ported verbatim:

- The defaults: at least 2 items, a core field in 80% of the rows, the
  heterogeneous core ratio 0.6, at most 6 flattened inner keys, 2 to 8 buckets,
  the discriminator uniqueness cap 0.7, and the lossless savings floor 0.15
  against `estimate_array_bytes` (the rows' compact JSON plus their commas and
  brackets).
- `crush_array_with_source`'s order: an array within the adaptive K is left to
  recursion before compaction is tried; a winning table replaces the array as a
  string; without the lossy stage (`lossless_only`) an array whose table did
  not win stays whole and is not descended into.
- `compact_inner`: fewer than 2 items or a non-object item stays untouched; key
  frequencies over the sorted key set; buckets by a discriminator (in every
  row, all strings, 2 to 8 values, at most 70% unique; most buckets wins, the
  first key on ties) when under 60% of the keys are core, each bucket compacted
  on its own and a bucket that is no table rendered as a one-column
  `value:json` table; otherwise one table, columns by descending frequency,
  then name.
- `infer_type_tag` (the first non-null type, `json` on a conflict, `string`
  when all null), nullability (a missing key or a null), `cell_from_value` with
  opaque markers off (an array of 2+ objects nests; a string holding a JSON
  object or array, and no `<<ccr:` marker, is replaced by its value or a nested
  compaction), and `flatten_uniform_nested` (1 to 6 identical inner keys,
  order-sensitive, never on a dotted column; types and nullability re-inferred
  from the cells).
- The csv-schema format without a drop summary: `[N]{name:type,name:type?,…}`,
  one CSV row per record, each line ending in `\n`; `__buckets:<disc>` and
  `__key:<value>` lines; a missing key empty, `null` bare, `""` and `"null"`
  quoted; CSV quoting of `,` `"` `\n` `\r`; a string a `json` column could read
  as a value written as a quoted JSON literal; a nested cell as quoted
  `compaction_to_json`. `process_string`'s rule: a stringified array that
  compacts becomes the table string itself, never a double-encoded one.
- A top-level array that compacts comes back as a JSON string literal holding
  the table (upstream's wrapper, documented by compaction_codec.py `_peel`).
  Its `\n` escapes can make it fail the crusher's existing not-shorter gate
  after it passed the 15% floor, as upstream.

Deviations:

- A column name holding `,` `:` `{` `}` `?` or a line break leaves the array
  untouched, and such an inner key keeps its column nested: upstream writes
  names unescaped, so the header would no longer decode, and a lossless rewrite
  keeps no CCR copy.
- A stringified cell whose value `JSON.parse` would not render back the same
  (`isLossy`) stays a string, so no digit or duplicate key is lost.
- One compaction's work (key reads plus table cells) is charged to a budget of
  4 per character of the array's compact JSON + 4096, and the stage declines
  when it runs out: a sparse key set (thousands of distinct keys) would
  otherwise build a rows × columns table synchronously. Such a table could not
  pass the 15% floor anyway, since every cell renders at least one character.
  The discriminator scan reads values only for keys present in every row, so
  it stays linear in the key occurrences.
- Numbers type as `int` when `Number.isSafeInteger`, else `float`, and cells
  render as `String(n)`: `JSON.parse` keeps no lexeme, so `1.0` reads `int` and
  `1.50` renders `1.5`, where upstream's `arbitrary_precision` keeps both. The
  document still passes `isLossy` first.
- Lengths count UTF-16 units where upstream counts UTF-8 bytes (the savings
  ratio shifts slightly on non-ASCII input); keys sort by UTF-16 code units
  where upstream's `BTreeMap` sorts UTF-8 bytes (different only for astral or
  high-BMP names); JS lists integer-like object keys first, which can change
  the flatten key-list comparison and the dotted column order. No value changes.
- Opaque-blob CCR stays off (`emit_opaque_markers=false` semantics): long
  strings stay verbatim cells and no `<<ccr:HASH,KIND,SIZE>>` cell is written.
- Deferred: the markdown-kv and JSON formatters, the drop summary,
  `factor_out_constants` and TOIN.

Savings: a crushed document that lost nothing books all of its saved
characters to `compaction`; otherwise `compaction` gets the tables' own savings
(capped at the total) and the crusher the rest.
