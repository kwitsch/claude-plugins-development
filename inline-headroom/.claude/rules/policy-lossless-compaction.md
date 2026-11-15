---
paths:
  - "src/hooks/policy.mts"
  - "tests/policy.test.mts"
---

# Lossless compaction (`policy.mts`)

## Lossless compaction

A port of upstream headroom's lossless-first SmartCrusher stage
(`crates/headroom-core/src/transforms/smart_crusher/compaction/compactor.rs`,
`formatter.rs` and `classifier.rs`, and `crusher.rs`
`crush_array_with_source`, read 2026-10-11 at 976aa71) into
`src/hooks/policy.mts` as `compactRows`, `formatCsvSchema` and `compactionJson`,
run by `crushDictArray` inside the `crush` step, before the lossy path
(SmartCrusher: `policy-smartcrusher.md`). It has its own toggle,
`lossless_compaction_enabled`, and its own `compaction` table
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
