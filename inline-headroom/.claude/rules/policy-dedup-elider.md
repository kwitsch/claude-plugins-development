---
paths:
  - "src/hooks/policy.mts"
  - "tests/policy.test.mts"
---

# Cross-turn dedup and dense line elider (`policy.mts`)

## Cross-turn dedup

A port of upstream headroom's cross-turn verbatim de-duplication
(`headroom/transforms/cross_turn_dedup.py` and the `content_router.py`
`_cross_turn_dedup_messages` wiring, read 2026-10-11 at 976aa71) into
`src/hooks/policy.mts` as `dedupBlock`.

Ported verbatim:

- `DEFAULT_MIN_LINES` 3, `DEFAULT_MIN_CHARS` 40 (on the joined span) and
  `MAX_ANCHOR_CANDIDATES` 16, in first-seen order.
- The unpadded line-number regex `^([1-9]\d*)(:|\t)(.*)$`. Leading-zero runs
  never renumber-fold.
- Match keys modulo the line number, with a uniform delta inside a run.
  Non-numbered lines must match exactly.
- The trivial-line set and the `< 4` rule.
- The longest run wins; a tie keeps the earliest. Folded lines become null, so
  they never seed a later match (keep-earliest).
- Only surviving verbatim lines are indexed. Protected blocks (here: error
  results, `headroom_retrieve` and own-storage rows) are indexed as targets and
  never rewritten.
- Only string content or a single non-empty text sub-block takes part.
- Dedup runs after per-block compression, over the final text.
- Prefix-monotonic, because each block matches only strictly earlier output and
  stored rows are immutable.

Deviations from upstream:

- Incremental at append time instead of a per-request batch. The corpus is per
  conversation (the main loop, or one `agentId`) and lives in module memory
  (`dedupStates` in `register.mts`). It is capped at `DEDUP_MAX_CHARS`
  (4,000,000) indexed characters across conversations, emptying the least
  recently appended conversation first (`resetCorpus`), or the current one when
  it alone exceeds the cap. An emptied conversation keeps its ordinal counter,
  so a later pointer never reuses the number of a result that left the corpus.
  The same reset runs on a finished agent's `turn.complete` (its corpus would
  otherwise count toward the cap that evicts the main loop's), on the
  compacting loop's `session.compact` (the results it indexes left the model's
  context; not on a skip or a `precompute`, which installs nothing) and on a
  throw inside `rewriteToolResults`. It is cleared whole on `session.end` and
  lost on a mod reload. Claude Code's own clearing or trimming of old tool
  results without a compaction raises no event, so the corpus keeps such a
  result and later re-reads fold into pointers to text the model no longer
  sees (recovery: `headroom_retrieve` from `folded`); accepted, documented in
  the README Notes.
- The pointer names `result N`, where N is the mod's 1-based ordinal of the
  conversation's indexed tool results, instead of `msg N`. N is the message
  index in upstream's request; the mod has no request-level view at append
  time.
- The pointer appends a space and `hash=H`. Upstream recovery is in context only, but the mod
  also stores the folded run's exact text in the `folded` CCR store, so a pointer whose
  original was compacted away stays recoverable while the mod is loaded.
- Because of that suffix, a fold is emitted only when the pointer is shorter
  than the run. Upstream relies on `min_chars` alone for its net win.
- The anchor is quoted with `JSON.stringify` (always double quotes) instead of
  Python `repr`. It is truncated by code points, as upstream does.
- A line number beyond `Number.MAX_SAFE_INTEGER` is treated as non-numbered.
- A `:` separator directly followed by a digit (`10:15:03 …`, `8080:80`) is not a
  line number: the leading integer is a time or port, so such lines match
  exactly.
- JS `\d` is ASCII-only where Python's `str` regex `\d` is Unicode.
- Lengths count UTF-16 units.

Wiring: `rewriteToolResults` calls `dedupBlock` last, over each tool_result's
final text of every content type (after the crusher or the elider), with the
key `""` for a main-loop row and the `agentId` for a subagent row. Folds count
in the `dedup` table's session-only `spans` and `saved`. A `Read` row is only
indexed, like a protected one (user decision): a re-Read after an Edit must show
the file verbatim for the next Edit's `old_string`, and a later Bash `cat` of
the same file still folds against it. Upstream protects only its verbatim
exclude list (WebSearch, WebFetch, the retrieve tools, `view`).

Behaviour change (0.7.0): with `tag_protector_enabled` on (the default) a line
a custom tag span touches never starts a fold, and a run ends before the first
such line (both mod-side; see `## Tag protector` (`policy-text-tags.md`)), so a repeated
`<system-reminder>` block stays verbatim while the runs around it still fold.
Tagged lines are still indexed. A text the tag scan cannot finish within its
budget is only indexed.

## Dense line elider

A port of upstream headroom's dense line elider
(`headroom/transforms/dense_line_elider.py`, the `content_router.py`
`_elide_dense` CCR marker and `recursive_json.py` `scan_json_documents`, read
2026-10-11 at 976aa71) into `src/hooks/policy.mts` as `elideDense`.

Ported verbatim:

- `MIN_LINE_CHARS` 300; `MAX_SPACE_RATIO` 0.06, with `>=` rejecting;
  `MIN_DENSE_TOTAL_CHARS` 2000; `HEAD_CHARS` 160; `TAIL_CHARS` 80.
- The early return below 300 characters, the tab guard and the JSON-shaped
  guard.
- The labelled-JSON guard through the span scan (`scanFrom`, `noJsonSpans`),
  including the work budget of 4 per character + 4096, where an incomplete
  scan means not dense.
- The split on `\n` only, the per-line omission note
  `...[N chars of dense machine-generated content elided]...`, and the CCR
  retrieval line `[N dense machine-generated line(s) elided. Retrieve original: hash=H]`
  appended after the block, with the whole pre-elision block stored under the
  hash.
- No elision of text another compressor rewrote (SmartCrusher output; upstream
  `_DENSE_ELIDE_AFTER`).

Faithful-to-upstream consequences (kept, not bugs): a line holding a tab is
never dense, which covers every line of Read output (`N\t…`), and a line is not
dense when the span scan finds any JSON object or array in it, however small
(`{}`, `[1,2]`). A minified bundle with an `exports:{}` span, or any Read of one,
therefore stays whole. Upstream has no minimum span size or tab exemption;
relaxing either would diverge from it, so it is deferred.

Deviations from upstream:

- The 12-hex `hash64`-based `contentHash` stands in for upstream's CCR key, as
  for the crusher.
- A result that is not shorter than its input is passed through. Upstream
  would emit it; seven 300-character dense lines grow by the retrieval line.
- Lengths count UTF-16 code units, where upstream counts code points.
- Head and tail cuts never split a surrogate pair, so a cut may keep one unit
  less.
- `JSON.parse` rejects `NaN`/`Infinity` spans that Python's `json.loads`
  accepts, so such a span does not protect its line. A non-`SyntaxError` parse
  failure counts as an incomplete scan.
- `trim()` and Python `strip()` differ on a few exotic whitespace code points.
- Upstream disables elision in lossless mode; the mod has no lossless mode.
- Applied to every non-error tool result except `headroom_retrieve` and the
  mod's own storage tools.

Wiring: `rewriteToolResults` runs `elideDense` on every content type
(`ROUTES`), on each text the crusher did not rewrite (every text while
`smart_crusher_enabled` is off). Elided lines count in the `line elider`
table's session-only `lines` and `saved`.

Behaviour change (0.7.0): a text labelled `structured_config` (YAML, TOML or
INI) that the config compressor rewrites is no longer elided, as upstream
leaves CONFIG out of `_DENSE_ELIDE_AFTER`; with `config_compressor_enabled`
off, or when the compressor declines, the elider runs on it exactly as before.

Behaviour change (0.7.0): an HTML text the HTML extractor rewrites is elided as
its extraction (the elider runs after the extractor, upstream's
`_DENSE_ELIDE_AFTER` HTML member), so a dense line inside the page's text is
cut there and the page's markup never reaches the elider; the elider's
retrieval line then follows the extractor's, and its stored original is the
extraction. With `html_extractor_enabled` off, or when the extractor declines,
the elider runs on the page exactly as before.

Behaviour change (0.7.0): with `tag_protector_enabled` on (the default) a line
a custom tag span touches is never dense (mod-side; see `## Tag protector` (`policy-text-tags.md`)),
and after an HTML extraction the spans are those of the extracted text. A text
the tag scan cannot finish within its budget is not elided at all.

Behaviour change (0.8.0): on `build`, `search` and `text` the elider now sees
the log compressor's, the search compressor's or the text crusher's lossy
output (upstream's `_DENSE_ELIDE_AFTER` LOG, SEARCH and TEXT members), and its
retrieval line then follows that compressor's; after a lossless fold (or, on
`text`, a relevance split) it sees nothing, since those end the route. On
`diff` it sees nothing after a diff-compressor or index-strip rewrite (DIFF is
not in `_DENSE_ELIDE_AFTER`). With the new toggles off, or when every new step
on the route declines, it runs exactly as before.
