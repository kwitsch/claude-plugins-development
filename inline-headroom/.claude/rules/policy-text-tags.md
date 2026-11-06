---
paths:
  - "src/hooks/policy.mts"
  - "tests/policy.test.mts"
---

# Text crusher, relevance split and tag protector (`policy.mts`)

## Text crusher

A port of upstream headroom's TextCrusher
(`crates/headroom-core/src/transforms/text_crusher/crusher.rs` and `config.rs`,
the ASCII path, `TextCrusherConfig::default()`, wrapped by
`headroom/transforms/text_crusher.py`) and of the `text` kind of
`lossless_compaction.py` `compact_lossless`, read 2026-10-11 at 976aa71, into
`src/hooks/policy.mts` as `crushText` and `foldText`, reached through the `text`
route (`split`, `textcrush`, `textfold`, `elide`). It stands in for upstream's
Kompress (ML), which the mod cannot run. It has its own toggle,
`text_crusher_enabled`, and its own `text crusher` table (`texts`, `saved`);
the fold counts there too.

Gates (user decisions, deviations from upstream): the lossy crusher and the
relevance split run only on prose (`isProse`: at least half the non-empty lines
hold a sentence end, `.`, `!` or `?` before whitespace or the line end), since
upstream's one-segment-per-line fallback would halve a Glob, `find`, `ls` or
`git log --oneline` listing the router labels `text`; and never on an `Agent` or
`Task` result (`REPORT_TOOLS`), whose hand-back report ends with the agentId the
model resumes it with. The lossless `textfold` and the elider still run on both.

Ported verbatim:

- The segmentation (`split_segments_ascii`): each trimmed line, cut after `.`,
  `!` or `?` and the whitespace that follows; fewer than 6 segments pass.
- The tokens (`tokens_ascii`: alphanumeric or `_` runs, lowercased), the plain
  BM25 relevance (`bm25Scores`, the shared core of `relevanceScores`), the score
  `1.0 × (i+1)/n + 2.0 × relevance + 1.5 × salient/(words+1)`, × 0.25 under 12
  characters, and `is_salient` (an ASCII digit, an error/status keyword, 2+
  letters all uppercase, a dotted identifier).
- The selection: best first (ties by position), kept until half the
  characters are (`target_ratio` 0.5, checked before each candidate), skipping a
  candidate whose 3-token shingles are 85% covered by kept ones; the kept
  segments in order, joined by `\n`.
- The fold: `collapse_runs`, kept only when `expand_runs` inverts it and it is
  shorter.

Deviations:

- Text holding a CJK character (`TEXT_CJK_RE`, exactly upstream's `is_cjk`
  ranges) declines: upstream's ICU segmentation path is not ported.
- Eligibility: every `text`-labelled result of 300+ characters (the router's
  floor, above upstream `prose_field`'s 256) that is not Read output,
  line-numbered or tagged, markdown output included (never an `Agent` or `Task`
  report, see the gates above).
  Upstream reaches TextCrusher only past a 50,000-token Kompress gate (opt-in);
  here it stands in for Kompress wherever Kompress would run.
- The kept text ends with the mod's own `[Text crushed: K of N segments kept.
  Retrieve original: hash=H]`; a result that is not shorter declines.
- `target_ratio` is a constant (upstream clamps a per-call value to 0.05–1.0);
  lengths count UTF-16 units where upstream counts UTF-8 bytes; JS `\b` (BM25's
  tokenizer) is ASCII-only.

Wiring: on the `text` route `textcrush` runs after `split` (when the split
declined), adopted only through `overFold` against `foldText`; then `textfold`
(only on the route's input), then `elide`. An adopted crush is handed on to the
elider; an adopted fold ends the route.

Behaviour change (0.8.0): prose tool results of 6+ sentences (WebFetch
summaries, markdown command output; never Agent or Task reports) now reach the model as
about half their characters, without their line breaks and indentation, and
cross-turn dedup indexes that crushed form (a repeated report is crushed the
same way, then folded into a pointer). `text_crusher_enabled: false` restores
the earlier path.

## Relevance split

A port of upstream headroom's prompt-conditioned relevance split
(`headroom/transforms/relevance_split.py` `segment`, `_otsu_threshold`,
`adaptive_threshold`, `plan_relevance_split`, and
`headroom/transforms/content_router.py` `_relevance_split_compress` and
`_json_straddles_segments`), read 2026-10-11 at 976aa71, into
`src/hooks/policy.mts` as `splitRelevance`, `segmentRecords`, `adaptiveThreshold`
and `otsuThreshold`. It is the first step of the `text` route. It has its own
toggle, `relevance_split_enabled`, and its own `relevance split` table
(`texts`, `saved`).

Ported verbatim:

- `segment(window=8, max_chars=1200)`: a lossless partition into blank-line
  blocks packed into windows of 8 lines (indented continuations held past
  that) and 1200 characters, a single longer line whole.
- The scores (plain BM25 against the conversation query), the cut
  (`adaptive_threshold` with the 0.25 floor: the floor when fewer than 2
  distinct scores, else the Otsu midpoint, at least the floor), KEEP from the
  cut up, consecutive records of one disposition merged into runs.
- An empty query, a single record or no DROP run means no split; the result is
  adopted only when it beats plain whole-block lossless compaction.

Deviations:

- Routed on `text` only (user decision); upstream splits LOG and SEARCH output,
  where the log and search compressors run here. Because of that the split has
  no `kind`: the fold it uses is `foldText`.
- DROP runs become `...[N low-relevance line(s) elided]...` with one final
  `[N low-relevance line(s) in R run(s) elided. Retrieve original: hash=H]`
  line and the original stored: upstream's CCR-mode disposition
  (`relevance_split.py` docstring), since the mod always has retrieval. Upstream
  hands the DROP tail to Kompress.
- A DROP run holding an `ERROR_KEYWORDS` entry (lowercased substring, as the
  crusher tests rows) is kept whole, and a split with no KEEP run left declines
  (user decision; upstream would emit DROP markers only).
- `foldText` belongs to `text_crusher_enabled`: KEEP runs are folded, and the
  adoption baseline is the folded whole text, only while that lever is on; with
  it off the split never calls `foldText`, KEEP runs stay raw and the baseline
  is the raw text (user decision).
- The JSON straddle guard declines when any top-level balanced `[`/`{` span
  crosses a record cut, found by `noJsonSpans`' budgeted walk (an exhausted
  budget declines); upstream protects only spans that parse as JSON documents
  or record arrays. One-line spans (JSONL) never straddle.
- The query is `crushQuery` (the last 5 user texts and recent tool inputs), not
  `build_relevance_query`'s prompt plus the triggering call's arguments; the
  scorer is BM25 only (no embedding or hybrid tier), and there is no
  `max_records` cap.
- Lines split on `\n` only (Python's `splitlines` also splits on `\r`, `\v`,
  `\f`, `\x1c`–`\x1e`, `\x85`, U+2028 and U+2029); 9-decimal rounding in the
  distinct-score check uses `Math.round`.

Wiring: `split` runs first on the `text` route, ahead of `textcrush`, as
upstream's split returns before its strategy dispatch; a split rewrite ends the
route (no crush, no elision), and when it declines the text crusher, its fold
and the elider run as without it. It needs a query: `wantsQuery` fetches the
transcript for it, and with no query it declines.

## Tag protector

A mask-free port of upstream headroom's tag protector
(`crates/headroom-core/src/transforms/tag_protector.rs` `identify_spans` and
`parse_tag_at` in block mode, `compress_tagged_content=false`, read 2026-10-11
at 976aa71) into `src/hooks/policy.mts` as `tagSpans`, sharing the lexer `tagAt`
with the HTML extractor. It has its own toggle, `tag_protector_enabled`, no
`compressOn` term and no `/headroom` table: it saves nothing itself, it only
narrows what the compression levers rewrite.

Ported verbatim:

- The HTML5 element set (`HTML5_TAGS`, all 116 names of `HTML5_TAGS` in
  `tag_protector.rs`), matched case-insensitively; every other name is a custom
  tag (`is_known_html_tag`).
- `parse_tag_at`: a name starts with an ASCII letter or `_` and continues with
  letters, digits, `_`, `-`, `.` and `:`; a close tag allows whitespace before
  `>`; an open tag's attributes run to the first `>` outside quotes, an
  unterminated quote makes no tag, and `/` marks it self-closing until
  whitespace or a quoted value follows.
- `identify_spans` in block mode: a self-closing custom tag is a span; a custom
  close matches the top-most open of its name (`rposition`), drops the opens
  above it and the spans inside it, and records the whole block; an orphan
  close or an unmatched open is never protected.

Deviations:

- Mask-free: no placeholders, no `restore_tags`, no salted prefixes. Upstream
  protects only around its ML text compressors, which the mod does not have;
  here every compression lever honours the spans on its own terms (all
  mod-side):
  - the SmartCrusher runs a JSON text holding a span without the lossy stage
    (lossless compaction may still re-encode it, every string verbatim in a
    cell; no row or item is dropped);
  - the dense line elider never treats a line a span touches as dense;
  - cross-turn dedup never starts a fold on a tagged line and ends a run before
    one, but indexes tagged lines like any other;
  - the config compressor, the HTML extractor, the log, search and diff
    compressors, the text crusher and the relevance split decline a text
    holding a span;
  - after an HTML extraction `shrink` recomputes the spans on the extracted
    text before the elider runs, so a custom tag the entity decoding produced
    (`&lt;system-reminder&gt;`) is guarded like any other; a null there returns
    the extraction unelided.
- A work budget: the characters the lexer scans and every stack entry a close
  examines share one budget of 4 per character + 4096. Exhaustion returns null:
  the text is unprotectable, and every lever passes it through unchanged (dedup
  only indexes it). Upstream has the same unbounded weakness (it re-parses after
  every `<` that is no tag and walks the whole stack per close), so many custom
  opens followed by many non-matching closes would go quadratic.
- The content of an HTML5 `<svg>` or `<math>` element, up to its first
  case-insensitive close tag (an unclosed one skips nothing), is not scanned: SVG and MathML children (`path`,
  `g`, `mi`, …) are no workflow tags, and without this the elider would stop
  eliding SVG path data.
- The spans inside a matched block are dropped by popping the tail of the
  sorted span list (amortised linear) where upstream filters the whole list.
- Vocabulary as upstream: every non-HTML5 name counts, so XML, JSX/TSX
  components and Vue templates are protected too, and re-reads of such files
  fold and elide less. `tag_protector_enabled: false` restores the levers'
  earlier behaviour.
- Cost: one budgeted scan per distinct text holding a `<` (the last scan is
  reused when dedup receives the route's unchanged final text), two for an HTML
  page the extractor rewrote.
