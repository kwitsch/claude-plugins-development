---
paths:
  - "src/hooks/policy.mts"
  - "tests/policy.test.mts"
---

# Content router (`policy.mts`)

## Content router

A port of upstream headroom's content detection into `src/hooks/policy.mts` as
`detectContentType`: the branch heuristics of
`headroom/transforms/content_detector.py`, the category set and branch order
of `crates/headroom-core/src/transforms/content_detector.rs`, and
`_TIMESTAMP_ROW_RE` from `headroom/transforms/lossless_compaction.py`, read
2026-10-11 at 976aa71. It labels each unprotected tool-result text with one
tag: `json_array`, `diff`, `html`, `tabular` (git status), `search`, `build`,
`structured_config`, `source_code` or `text`.

Ported verbatim:

- The branch order and gates: empty → `text`; JSON; diff (≥ 0.7); HTML
  (≥ 0.7); git status; search (≥ 0.6); log (≥ 0.5); structured config; code
  (≥ 0.5); else `text`.
- The line and character windows: diff over the first 500 lines, HTML over the
  first 3000 characters, search over the first 100 lines, log over the first
  200 lines, code over the first 100 lines.
- Every regex and threshold of the ported branches: `_TIMESTAMP_ROW_RE`, the
  path-shape guard (no `<`, `>` or `=` before the line number), grep context
  lines (`path-N-` whose path holds a `/` or `.`, and `path:N-`), the ≥ 2-match
  search floor and its 0.3 ratio, all 24 log patterns and their 0.1 ratio, the
  8-language code patterns (anchored at the line start, as `re.match` is) and
  the best score of 3, the JSON wrapper bulk fraction 0.6, the concatenated
  ≥ 2-objects rule, and the git-status first lines, headings and entry regex.
- The confidence formulas, in upstream operand order, so IEEE borderline cases
  match: one diff header and no change line gives exactly 0.7, which passes,
  and a search ratio of 1/3 gives 0.6, which passes.
- The type tags (upstream `ContentType` values).

Deviations from upstream:

- Rust's category set plus Python's structured-config branch (its tag
  `structured_config` has no Rust counterpart). Its YAML/TOML/INI flavor comes
  from line-level checks in place of `tomllib` and `configparser` (see
  `## Config compressor` (`policy-compressors.md`)), so it can claim text upstream's parsers would
  reject; it only takes text that would otherwise be code or plain text, whose
  route was the elider alone. Python's tabular (markdown table, CSV/TSV) and
  fixed-width branches stay omitted: they too only take such text, and the
  newer tabular branch disagrees with upstream's own parity fixtures (it reads
  the JavaScript fixture as `tabular`).
- JSON follows Python, not Rust: objects, wrapped payloads and concatenated
  objects count, not only arrays. The parity fixture `{"foo": "bar"}`
  therefore reads `json_array` (Rust records `text`).
- `raw_decode` is emulated by the span walker `scanFrom` plus `JSON.parse`. A
  non-`{` value ends the concatenated check, where upstream decodes it and then
  rejects the run; the verdict differs only when that value would hit the
  recursion limit.
- `JSON.parse` rejects `NaN`/`Infinity`, which Python's `json` accepts. A
  `JSON.parse` failure other than a `SyntaxError` counts as upstream's
  `RecursionError` (not JSON).
- JS `\w`, `\d` and `\b` are ASCII-only where Python's are Unicode; `\s` and
  `trim()` differ from Python's on a few exotic code points.
- Lengths (the 3000-character HTML sample, the bulk fraction) count UTF-16
  units, where upstream counts code points.
- Each sampled line is cut to `DETECT_MAX_LINE_CHARS` (1000) before the diff,
  search, log and code checks: the PHP and C# stack-trace patterns backtrack
  quadratically, and detection runs synchronously on every appended result. A
  signal beyond that column of a line goes unseen.
- A text whose first line carries an `N\t` line number (Read output, `cat -n`) is never labelled `html`: it is a
  file's source, and extracting it would leave the Edit tool nothing to match.
- The detector returns only the tag: no confidence and no metadata (language,
  counts), since nothing consumes them.

Routing: a light port of `headroom/transforms/content_router.py`
(`_strategy_from_detection`, `_DENSE_ELIDE_AFTER`, the git-status early return
and the passthrough-fallback elision, read 2026-10-11 at 976aa71). The
module-private `ROUTES` table maps each tag to its ordered steps:
`json_array` runs `crush` then `elide`, `structured_config` runs `config` then
`elide`, `html` runs `extract` then `elide`, `build` runs `log`, `logfold`
then `elide`, `search` runs `search`, `searchfold` then `elide`, `diff` runs
`diff`, `difffold` then `elide`, `text` runs `split`, `textcrush`, `textfold`
then `elide`, and `tabular` and `source_code` run `elide` alone.
`rewriteRow`'s `shrink` detects once per unprotected text and runs that type's
steps in order, skipping a step whose lever is off; the first step that
rewrites wins, except that a step in `ELIDE_AFTER` (`extract`, `log`, `search`
and `textcrush`, upstream's `_DENSE_ELIDE_AFTER` HTML, LOG, SEARCH and TEXT
members) hands its rewrite on to the next step. Any other rewrite ends the
route: the crusher, the config compressor, a diff rewrite, every fold and a
relevance split, as upstream returns a kept fold and a split before its
elision point and leaves SMART_CRUSHER, CONFIG and DIFF out of
`_DENSE_ELIDE_AFTER`; the elider still runs as the fallback when every step
before it declined. A lossy step sits before its kind's lossless fold because
it has to beat that fold, which is the floor: `overFold` adopts it only at
most `(1 - LOSSY_MIN_EXTRA_SAVINGS)` (0.95) of the fold's length when the fold
shrinks the text (upstream's `lossless_then_lossy` gate,
`_DEFAULT_LOSSY_MIN_EXTRA_SAVINGS`). A fold is the fallback for a lossy step
that declined or lost to it, never a post-processor of an adopted lossy
result, which goes straight to `elide`: a fold step runs only while the text is
still the route's input (`cur === text`). Detection runs only while a lever some
route runs ahead of the elider is on (every compression lever but dedup and the
elider), so a dedup-only or elide-only configuration pays nothing, and only on
a text of at least `ROUTE_MIN_CHARS` (300, the router-wide floor; the new
steps' upstream floors are lower, but under 300 characters a retrieval line
would eat most of any saving), since a shorter one is passed through whatever
its label. The router compressors (log, search, diff, text crusher, relevance
split) leave Read output and line-numbered (`N\t`, `cat -n`) text whole, as the
HTML extractor does and dedup only indexes it, so the Edit tool can still match
it, and decline a text holding a tag span. Dedup (`dedupBlock`) then runs over
every type's final text, unchanged.

Routing deviations from upstream:

- A JSON text the crusher declined is still elided. Upstream skips elision
  after any SmartCrusher attempt (`_DENSE_ELIDE_AFTER` leaves it out).
- Git status and source code get the elider, as upstream does where a type's
  compressor is unavailable (the passthrough fallback). Upstream keeps git
  status verbatim; here the elider's tab guard already leaves every
  tab-indented entry line whole, and a compound output such as
  `git status; cat app.min.js` keeps its elision.
- Dedup stays type-agnostic.
- The fold floor: upstream's default (`lossless_then_lossy = False`) ends the
  route on any fold that shrinks the text, under which the ported compressors
  would almost never run (every `git diff` has `index` lines, two consecutive
  grep rows of one file fold, a log with one repeated line folds). The router
  uses upstream's opt-in `lossless_then_lossy` gate with its default 0.05
  instead; the lossy step runs on the raw text, not on the folded text as
  upstream's Kompress layer does (the per-kind parsers need the raw shape), and
  the diff route uses the gate too (upstream keeps Kompress off diffs; the diff
  compressor is upstream's own DIFF strategy and never emits `index` lines).
- Upstream's `DEFAULT_EXCLUDE_TOOLS` (`headroom/config.py`: Read, Glob, Grep,
  Write, Edit, WebSearch, WebFetch, Skill, … never lossily compressed) is not
  adopted: every lever rewrites results of any tool except error and protected
  rows, and the router compressors and the HTML extractor also leave Read and
  line-numbered text whole. Adopting the list would leave the search
  compressor idle on Claude Code's Grep tool.
- The relevance split routes only on `text` (user decision), ahead of the text
  crusher and folding with `foldText`, never on `build` or `search` where
  upstream runs it; it keeps any record run holding an `ERROR_KEYWORDS` line
  and declines when no KEEP run would remain (see `## Relevance split` (`policy-text-tags.md`)).
- A light router: no `is_mixed_content` / MIXED, no Magika or native detector,
  no `_strip_detection_envelope`, no embedded-JSON splice, no cross-kind
  lossless probing (`_lossless_first`: each step tries only its own kind's
  fold, and the `paths`, `html`, `tabular`, `source_code` and `json_array`
  folds are not ported), no Kompress (TextCrusher stands in for it on prose) or
  LOG fallback chains, no TOIN recording, and no `normalize_concatenated_json`
  (the crusher still takes only one whole JSON document).

Decisions:

- No userConfig toggle. The router has no behaviour of its own; which text a
  lever sees is governed by that lever's toggle and documented per lever. The
  router is infrastructure, and each future compressor brings its own toggle
  (a deliberate no-toggle exception to the toggle convention in the plugin
  `CLAUDE.md`).
- Per-compressor `/headroom` tables exist (`compaction`, `config`, …), but
  per-type label counts stay omitted: a label alone saves nothing.

Adding a compressor: name a new `RouteStep`, add its case in `rewriteRow`'s
`shrink`, a `Levers` flag fed by its own `*_enabled` toggle in `register.mts`
(plus its term in `compressOn`), a `RowRewrite` accumulator and `/headroom`
table if it reports savings, and its step in the `ROUTES` entries of the types
it fits, deciding whether `elide` still runs on its rewrite (put the step in
`ELIDE_AFTER`, as upstream's `_DENSE_ELIDE_AFTER` does). A lossless fold is a
`RouteStep` of its own that ends the route, and its branch requires
`cur === text`, so it runs only on the route's input and never on a handed-on
(lossy) rewrite; a lossy step that has a fold sits before it and gates on
`overFold(r, foldX(cur))`. A step that reads the query must also be added to
`wantsQuery`'s lever term, or its rows are rewritten without one.
