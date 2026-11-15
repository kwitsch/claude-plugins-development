---
paths:
  - "src/hooks/policy.mts"
  - "tests/policy.test.mts"
---

# Config, HTML, log, search and diff compressors (`policy.mts`)

All five are ports of upstream headroom read 2026-10-11 at 976aa71. Each has its
own `*_enabled` toggle and `/headroom` table. Wiring (route steps, `overFold`,
`ELIDE_AFTER`, the `cur === text` fold rule, Read, line-numbered and tagged text
left whole, Grep not excluded): `## Content router` (`policy-router.md`). Facts
also stated in a function's TSDoc are not repeated here.

## Config compressor

Port of `headroom/transforms/config_compressor.py`, the `collapse_runs`,
`expand_runs`, `fold_repeated_blocks` and `unfold_repeated_blocks` helpers and
`compact_lossless(…, "config")` of `headroom/transforms/lossless_compaction.py`,
and `_try_detect_structured_config` of `content_detector.py`, as
`compressConfig`, `configFlavor`, `isIniAssign` and the fold helpers; route
`structured_config`. Toggle `config_compressor_enabled`, table `config`
(`texts`, `saved`).

Ported verbatim:

- Detection: the regexes `_CONFIG_SECTION_RE`, `_TOML_ASSIGN_RE`,
  `_YAML_KEY_RE`, `_YAML_LIST_RE`, `_YAML_DOC_RE` and `_CONFIG_COMMENT_RE`; a
  `{` or `<` first character is no config; at least 3 non-empty and 3 body
  lines (comment lines are neutral); TOML/INI needs a section header, 2
  assignments and a 0.6 share, and a text over 1,000,000 characters never
  reads as TOML/INI; YAML needs 3 keys, a 0.6 share of keys, list items and
  document markers, under half the lines ending a sentence, at most 8 words a
  line, and 2 indent levels, a document marker or 3 list items; the markdown
  front-matter guard. The branch sits after log and before code, upstream's
  position (the tabular branch upstream checks in between stays omitted).
- Tier 2: whole-line comments (`^\s*#`; INI only column-0 `#` or `;`) and,
  outside INI, blank lines are dropped behind
  `[N comment/blank lines elided. Retrieve original: hash=H]`, the original
  stored first; skipped for a YAML block scalar (`key: |`, or a sequence item
  `- |`) or a TOML multi-line string.
- Tier 1: runs of 2+ identical lines become `... (repeated N times)`, then a
  run of 3 to 64 lines repeating the lines D back (K <= D) becomes
  `... (repeats K lines from D lines back)` when its characters exceed the
  marker's, with at most 8 recent positions per distinct line and no fold on a
  text under 6 or over 20,000 lines; kept only when the inverse gives the text
  back exactly and it is shorter. Deviation: when Tier 2 elided nothing, a
  Tier 1 fold appends `[Repeated config lines folded. Retrieve original: hash=H]`
  and stores the original, so a following Edit can get the exact text
  (upstream's Tier 1 markers carry no recovery hint).
- A result that saves less than one character is discarded, its stored
  original with it.

Deviations:

- Line-level checks stand in for `tomllib` and `configparser`: a section text
  is TOML when every assignment is a TOML key whose value lexeme reads as TOML
  (a basic or literal string, a number, `inf`, `nan`, a boolean, an RFC 3339
  date/time, an array or inline-table opener), else INI when every assignment
  is an INI one, else no TOML/INI (and the YAML checks run). That reproduces
  upstream's flavor vectors (`x = "1"` is TOML, `x = hello` INI) but can claim
  text a parser would reject; Tier 1 verifies itself and Tier 2 keeps the
  original retrievable, so a wrong label costs nothing irreversible.
- `isIniAssign` is a linear scanner for `_INI_ASSIGN_RE` (reason in its TSDoc).
- INI also refuses Tier 2 around `"""` or `'''`, since its flavor is not
  parser-confirmed.
- The inverse helpers stop once their output would outgrow the text being
  verified, so a marker-shaped line with a huge count, or markers doubling each
  other, never allocates it (upstream expands such input in full).
- Detection reads the detector's line-capped sample (the first 200 of its 500
  lines, each cut to 1000 characters), not the whole text.
- Deferred: Tier 3, the TOML array-of-tables schema fold (it needs a real TOML
  parser), upstream's `paths` fold and its cross-kind lossless probing
  (`_lossless_first`); the log, search, diff and text folds are ported with
  their compressors.

## HTML extractor

Bounded, hand-written stand-in for `headroom/transforms/html_extractor.py`
(trafilatura) with its `content_router.py` wiring and `_DENSE_ELIDE_AFTER`
membership, as `extractHtml`; route `html`. Toggle `html_extractor_enabled`,
table `html extractor` (`pages`, `saved`). Shares the tag lexer `tagAt`
(upstream `tag_protector.rs` `parse_tag_at`) with the tag protector.

Ported verbatim:

- The routing: `html` is extracted, and the dense line elider then runs on the
  extraction (`_DENSE_ELIDE_AFTER` holds HTML; `ELIDE_AFTER` here).
- An empty extraction falls through (upstream #3609): the elider then runs on
  the page as it is, and no block is discarded.
- trafilatura's settings as far as they apply: links and tables kept, images
  and comments dropped, recall over precision, markdown-ish output.

Deviations:

- No trafilatura (a third-party package; the mod takes no dependencies): one
  forward pass (dropped elements: `HTML_DROP`; rendering, budget and the
  not-shorter gate: `extractHtml`'s TSDoc). Tables render one row per line;
  the decoded entities are `&amp; &lt; &gt; &quot; &apos; &nbsp;` plus decimal
  and hex references (`HTML_ENTITY_RE`). Close tags match case-insensitively.
  No main-content scoring and no metadata, so its output differs from
  upstream's and keeps more of the page.
- The original page stays retrievable (retrieval line, `offloaded` store);
  upstream's HTML path cannot be undone.
- Misroute risk: dense grep or log output carrying a doctype, an `<html>` tag
  or 3 structural tags can be labelled `html` (the HTML branch precedes search
  and log, as on upstream's regex path), and the extractor would then strip
  markup-looking text from it. The original stays retrievable.

## Log compressor

Port of `crates/headroom-core/src/transforms/log_compressor.rs`
`compress_with_store` with `LogCompressorConfig::default()` (the Rust port of
`headroom/transforms/log_compressor.py`) and of the `log` kind of
`lossless_compaction.py` `compact_lossless`, as `compressLog` and `foldLog`;
route `build`. Toggle `log_compressor_enabled`, table `logs` (`texts`,
`saved`); the fold counts there too.

Ported verbatim:

- The defaults: at most 10 errors and 10 fails (the first, the last, then the
  best by score), 3 context lines around every kept line, 5 deduplicated
  warnings, the first 3 stack traces at 20 lines each, every summary line, an
  adaptive total of 10 to 100 lines (`computeOptimalK`), and logs under 50
  lines (`split("\n")`, a trailing empty element counted) left alone.
- The level classifier's exact-casing words (ERROR, error, Error, FATAL, fatal,
  Fatal, CRITICAL, critical; FAIL(ED), fail(ed), Fail(ed); WARN(ING),
  warn(ing), Warn(ing); INFO/info/Info; DEBUG/debug/Debug; TRACE/trace/Trace),
  the leftmost-longest match with its ASCII word-boundary filter, and the level
  of the first valid match by position (`WARN: error` is a warning).
- The stack-trace state machine with all seven flavors (Python traceback, JS,
  Java, Rust error, Rust backtrace, Go panic, .NET), their opener and
  terminator rules, the 20-line cap that re-opens a continuing trace, and the
  runtime-frame collapse of an oversized trace (`RUNTIME_FRAME_PREFIXES` and
  `RUNTIME_FRAME_MARKERS`, 3 head frames, 5 app frames,
  `[... N frames collapsed]` indented by 6 spaces, scored 0.8).
- The summary-line rules, the pytest `short test summary info` scan (CRLF
  tolerant) and its cap reserve (each section's totals line and the first line
  starting with `E` and a space), the scores (error and fail 1.0, warn 0.5,
  info and unknown 0.1, debug
  0.05, trace 0.02, +0.3 in a trace, +0.4 on a summary line, at most 1), the
  warning dedupe key (the text before the first `:` or `=` verbatim, then
  digits → N, `0x…` → ADDR, `/…/` → /PATH/, in that order), the cap order
  (reserved, score, short-summary entry, line) and the
  `[N lines omitted: E ERROR, F FAIL, W WARN, I INFO; omitted: …]` line.
- The marker descriptor `summarize_omitted` (`: K file(s), M exception
  type(s) (A, B, …)`, at most 5 names, labels and files a kept line shows
  left out).
- The fold: ANSI colour codes dropped one-way, then `collapse_runs`, kept only
  when `expand_runs` gives the de-coloured text back and the result is shorter.

Deviations (beyond `compressLog`'s TSDoc):

- The skipped gate is `min_compression_ratio_for_ccr` (0.5); upstream's line
  says "Retrieve more".
- The simhash budget is 4 per character + 4096 comparisons; an exhausted
  budget keeps 100 lines because many distinct lines mean high diversity,
  where upstream lands on the maximum too.
- The format detector only labels the result upstream.
- JS `\d`, `\w` and `\b` are ASCII-only where Rust's are Unicode (the dedupe key,
  the level words' boundaries already were ASCII upstream).

## Search compressor

Port of `crates/headroom-core/src/transforms/search_compressor.rs`
`compress_with_store` with `SearchCompressorConfig::default()` (the Rust port of
`headroom/transforms/search_compressor.py`, scoring through
`crates/headroom-core/src/signals/keyword_detector.rs` in its Search context)
and of the `search` kind of `lossless_compaction.py` `compact_lossless`
(`search_heading`, `search_dir_heading` and their inverses), as
`compressSearch` and `foldSearch`; route `search`. Toggle
`search_compressor_enabled`, table `search` (`texts`, `saved`); the fold
counts there too.

Ported verbatim:

- The three-tier line parser (`parse_match_line`, `scan_marker`): the colon
  tier, the dash tier that walks past a `-N-` only on path evidence
  (`last_segment_has_extension`, `path_continues`, `has_extension_dot`), the
  permissive tier, the Windows drive prefix, the adjacent-separator rejection
  and the dash tier's hand-off when its confirmed boundary precedes the colon
  marker. Lines that do not parse are dropped (`lines_unparsed`).
- The scores: +0.3 per query context word (longer than 2 characters) found in
  the lowercased line; +0.5 for an error word, +0.3 for an importance word
  (whichever whole word comes first, case-insensitive), else +0.4 for a warning
  word; at most 1.
- The selection: files by total score (stable), at most 15; an adaptive total
  of 5 to 30 matches (`computeOptimalK` over `file:line:content`); per file the
  first, the last, then the best by (score, line), at most 5 and unique by
  (line, content), back in line order; `file:line:content` rows in path order
  with `[... and N more matches in FILE]`.
- The fold: timestamped log rows are never grep rows (`_TIMESTAMP_ROW_RE`).

Deviations (beyond `compressSearch`'s TSDoc):

- The skipped gates are `min_matches_for_ccr` (10) and the ratio (0.8);
  upstream's line says "Retrieve more".
- The path-check budget is 4 per character + 4096, shared by every
  candidate-marker scan of one text (upstream rescans a line per marker,
  quadratic on hostile input). The simhash count has its own budget, as for
  the log compressor.
- Context words are lowercased with `toLowerCase` (upstream: ASCII
  lowercase), deduped newest first and capped so substring matching stays
  under about 16M character comparisons (`contextWords`).
- A line number beyond `Number.MAX_SAFE_INTEGER` leaves its line unparsed
  (upstream: u64). Paths sort by UTF-16 code units (upstream: UTF-8 bytes), and
  scores sum in doubles where upstream sums f32.
- Lines are matched with `[^\n]*` where Python's fold regexes use `.`, which in
  JS would also stop at a `\r`.

## Diff compressor

Port of `crates/headroom-core/src/transforms/diff_compressor.rs`
`compress_with_store` with `DiffCompressorConfig::default()` and of the `diff`
kind of `lossless_compaction.py` `compact_lossless` (`diff_strip_index`), as
`compressDiff` and `foldDiff`; route `diff`. Toggle `diff_compressor_enabled`,
table `diff` (`texts`, `saved`); the index strip counts there too.

Ported verbatim:

- The gates: under 50 lines (`min_lines_for_ccr`, which gates the whole
  compression) or without a `diff --git`, `diff --combined` or `diff --cc`
  header the text is left alone; `split("\n")` keeps a `\r` on its line.
- The parser: pre-diff lines kept verbatim; mode, rename, similarity, copy and
  binary lines setting their flags (and falling through, as upstream); `---`
  and `+++` lines taken whole; `@@`, `@@@` and `@@@@` hunk headers (5 or more
  `@` fall through as content); `+`/`-` lines counted, every hunk line kept;
  other header lines outside a hunk (`index`, `old mode`, `new mode`) dropped.
- The caps: past 20 files the most-changed 20, in that order; past 10 hunks the
  first, the last and the 8 best middle hunks by score (stable), re-sorted by
  their `+N`; 2 context lines around each change, every `\` line kept, a hunk
  without changes keeping its first 2 lines. The `+A -D` totals count the lines
  of dropped hunks too.
- The scores (`score_hunks`): min(0.3, changes × 0.03), +0.2 per query context
  word, +0.3 once for `PRIORITY_PATTERNS_DIFF`, at most 1.
- The output: `new file mode 100644` / `deleted file mode 100644`, `Binary files
  differ`, and the `[N files changed, +A -D lines, H hunks omitted]` footer.
- The fold: `index <sha>..<sha> [mode]` lines dropped when that shortens the
  text, with no inverse check; the router only folds diff-labelled text.

Deviations (beyond `compressDiff`'s TSDoc):

- Upstream always returns the normalised output and adds `Retrieve full diff:
  hash=…` only under 80% of the lines, so a weaker compression is lossy with
  no retrieval. Here M in the retrieval line counts the lines before the
  marker.
- Context words: upstream counts a repeated word twice and matches every word;
  CJK query bigrams are not added.
- The footer counts every file and line, not only the 20 the cap keeps, and
  ends with `; N files omitted: <b-paths>` (at most `DIFF_OMITTED_NAMES`, 10,
  names, then `…`) when the cap dropped files (user decision; upstream's footer
  counts only the kept files and records the dropped names in its stats alone).
- The `diff --git a/(.+) b/(.+)$` header test is hand-written (the regex would
  backtrack quadratically on a long line with many `b/` after a space).
- The lossy diff breaks `git apply` (stale hunk counts, normalised mode and
  binary lines), as upstream; the retrieval line restores the exact diff.
