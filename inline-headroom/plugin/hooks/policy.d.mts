type Effort = "low" | "medium" | "high" | "xhigh" | "max";
type Counters = {
    steps: number;
    clamped: number;
    cache_drops: number;
    input_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
};
type Row = Counters & {
    hit?: number;
};
type QueryMessage = {
    role: "user" | "assistant";
    text: string;
    toolUses: readonly {
        input: Record<string, unknown>;
    }[];
};
/**
 * A crushed document: compact text, rows and items lost, arrays rendered losslessly and the characters those tables saved,
 * [hash, original text (a crushed array's JSON, an elided block, a folded span)] per crushed array.
 */
type CrushOutcome = {
    text: string;
    rowsDropped: number;
    compacted: number;
    compactSaved: number;
    offloaded: [string, string][];
};
type CrushModes = {
    lossy: boolean;
    lossless: boolean;
};
type FieldSpec = {
    name: string;
    type: string;
    nullable: boolean;
};
/**
 * One compaction cell (upstream CellValue without OpaqueRef): a scalar (any JSON value), a missing key, or a nested compaction.
 */
type Cell = {
    s: unknown;
} | {
    m: true;
} | {
    n: Compaction;
};
type Bucket = {
    key: string;
    fields: FieldSpec[];
    rows: Cell[][];
};
/**
 * The compaction IR (upstream Compaction without OpaqueRef): a table, buckets split by a discriminator, or the items untouched.
 */
type Compaction = {
    kind: "table";
    fields: FieldSpec[];
    rows: Cell[][];
} | {
    kind: "buckets";
    disc: string;
    buckets: Bucket[];
} | {
    kind: "untouched";
    value: unknown;
};
type WorkBudget = {
    left: number;
};
type Elision = {
    text: string;
    lines: number;
    offloaded: [string, string][];
};
/**
 * One conversation's dedup corpus: the last ordinal handed out, each indexed block's verbatim lines (null where folded) by
 * ordinal, the anchor index (match key → [ordinal, line] first-seen, at most 16), and the indexed characters.
 */
type DedupState = {
    turn: number;
    corpus: Map<number, (string | null)[]>;
    index: Map<string, [number, number][]>;
    chars: number;
};
type Fold = {
    text: string;
    spans: number;
    offloaded: [string, string][];
};
type ContentBlock = {
    type: string;
} & Record<string, unknown>;
/**
 * Upstream ContentType tags (as_str); 'tabular' is git status here, 'structured_config' is Python's (Rust has no such tag).
 */
type ContentType = "json_array" | "diff" | "html" | "tabular" | "search" | "build" | "structured_config" | "source_code" | "text";
type ConfigFlavor = "yaml" | "toml" | "ini";
/**
 * Which levers rewrite this row; dedup names the conversations map and this row's key ("" main, else agentId).
 * The log, search and diff compressors, the text crusher and the relevance split are off when omitted.
 */
type Levers = {
    crush: boolean;
    compact?: boolean;
    elide: boolean;
    config?: boolean;
    extract?: boolean;
    log?: boolean;
    search?: boolean;
    diff?: boolean;
    textcrush?: boolean;
    split?: boolean;
    tags?: boolean;
    dedup?: {
        states: Map<string, DedupState>;
        key: string;
    };
};
/**
 * A rewritten tool-result row: its blocks, the originals for the CCR store (`offloaded`: the crusher's and the elider's sole copies;
 * `folded`: dedup runs, which a pointer's earlier result still holds), and each lever's savings.
 */
interface RowRewrite {
    content: ContentBlock[];
    offloaded: [string, string][];
    folded: [string, string][];
    crush: {
        dropped: number;
        saved: number;
    };
    compact: {
        arrays: number;
        saved: number;
    };
    config: {
        texts: number;
        saved: number;
    };
    extract: {
        pages: number;
        saved: number;
    };
    elide: {
        lines: number;
        saved: number;
    };
    dedup: {
        spans: number;
        saved: number;
    };
    log: {
        texts: number;
        saved: number;
    };
    search: {
        texts: number;
        saved: number;
    };
    diff: {
        texts: number;
        saved: number;
    };
    textcrush: {
        texts: number;
        saved: number;
    };
    split: {
        texts: number;
        saved: number;
    };
}
/**
 * The in-memory, session-only /headroom counters (statsTables' `memory`).
 */
interface StatsMemory {
    subagents?: {
        steps: number;
        clamped: number;
    };
    crush?: {
        dropped: number;
        saved: number;
    };
    dedup?: {
        spans: number;
        saved: number;
    };
    elide?: {
        lines: number;
        saved: number;
    };
    compact?: {
        arrays: number;
        saved: number;
    };
    config?: {
        texts: number;
        saved: number;
    };
    extract?: {
        pages: number;
        saved: number;
    };
    log?: {
        texts: number;
        saved: number;
    };
    search?: {
        texts: number;
        saved: number;
    };
    diff?: {
        texts: number;
        saved: number;
    };
    textcrush?: {
        texts: number;
        saved: number;
    };
    split?: {
        texts: number;
        saved: number;
    };
}
export declare const EFFORT_ORDER: readonly ["low", "medium", "high", "xhigh", "max"];
export declare const CACHE_DROP_THRESHOLD = 0.6;
/** The /headroom table rows, top to bottom. `days`: the rolling window, today included; 0 = this session, in memory. */
export declare const ROWS: readonly [{
    readonly label: "session";
    readonly days: 0;
}, {
    readonly label: "today";
    readonly days: 1;
}, {
    readonly label: "7 days";
    readonly days: 7;
}, {
    readonly label: "30 days";
    readonly days: 30;
}];
/** Table column widths in cells: the row label, then each value column. */
export declare const CELL_WIDTHS: readonly [16, 8, 8];
/** Persisted days kept: the longest row's window, never less. */
export declare const RETAIN_DAYS = 30;
/** The name register.ts registers the retrieval tool under. */
export declare const RETRIEVE_NAME = "headroom_retrieve";
/** This plugin's name, as `next.origin.plugin` reads it for the mod's own `$` calls. */
export declare const PLUGIN = "inline-headroom";
/** headroom_retrieve's full name: the tool.register op serves a mod tool as `mcp__<plugin>__<name>`. */
export declare const RETRIEVE_TOOL = "mcp__inline-headroom__headroom_retrieve";
/** A JSON document is crushed only above this many characters (upstream min_tokens_to_crush 200 × 4 chars per token: the mod has no tokenizer). */
export declare const CRUSH_MIN_CHARS = 800;
/** Characters of assistant tool-call input JSON the crusher's query keeps in all, newest first (a deviation: upstream has no cap). */
export declare const CRUSH_QUERY_INPUT_CHARS = 16384;
/** Offloaded originals kept for headroom_retrieve, oldest evicted first (upstream CCR DEFAULT_CAPACITY). */
export declare const CCR_CAPACITY = 1000;
/** Characters of offloaded originals kept in all (about 32 MB as UTF-16), oldest evicted first. Deviation: upstream caps by count only. */
export declare const CCR_MAX_CHARS = 16000000;
/** Upstream ERROR_KEYWORDS: a row whose lowercased JSON holds one is never dropped. */
export declare const ERROR_KEYWORDS: readonly ["error", "exception", "failed", "failure", "critical", "fatal", "crash", "panic", "abort", "timeout", "denied", "rejected"];
/** Indexed dedup characters kept across all conversations, least recently appended conversation dropped first. Deviation: upstream rebuilds per request and needs no cap. */
export declare const DEDUP_MAX_CHARS = 4000000;
/**
 * Whether a tool.check decides this mod's own storage call: the mods API's `mcp.call` reaches core's permission step as a
 * `tool.call` (live on 2.1.296, although the typings promise no prompt), so without an allow rule a headless
 * session denies every `/headroom` write and an interactive one asks. The model's own storage calls are not covered.
 * @param originPlugin - `next.origin.plugin`
 */
export declare function isOwnStorageCall(originPlugin: string, tool: string): boolean;
/**
 * Clamp-only: returns `target` only when `current` is a known effort level
 * strictly above it; otherwise undefined (absent, numeric, unknown, at/below).
 */
export declare function clampEffort(current: unknown, target?: Effort): Effort | undefined;
/**
 * The routing rule shared by the main loop and every subagent: a mechanical
 * step (after index 0, no tool error since the loop's last step) is clamped.
 * @param index - the step's index in its loop (0 = the ask step)
 * @param errored - a tool error since that loop's last step
 * @param effort - the step's current effort
 * @returns the lowered effort, or undefined to leave it
 */
export declare function stepEffort(index: number, errored: boolean, effort: unknown): Effort | undefined;
/**
 * A tool.call result is a failure when it is errored or denied.
 */
export declare function isToolError(result: Record<string, unknown>): boolean;
export declare function cacheHitRatio(usage: {
    input_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
}): number | undefined;
/**
 * A ratio as a whole percentage, "–" when there is none.
 */
export declare function pct(n: number | undefined): string;
export declare function isCacheDrop(prev: number | undefined, hit: number): boolean;
/**
 * A usage field as a persistable counter delta: a non-negative safe integer, else 0. One missing or
 * odd field (undefined, NaN, a fraction) must not poison the running totals, because the server
 * rejects every stats_put that carries such a row.
 */
export declare function toCount(n: unknown): number;
/** @returns all six counters at 0 */
export declare function zeroCounters(): Counters;
/**
 * Local calendar day of an epoch-ms instant as YYYY-MM-DD.
 * @param offsetMin - minutes UTC minus local (Date#getTimezoneOffset); defaults to this runtime's offset at `ms`
 */
export declare function dayKey(ms: number, offsetMin?: number): string;
/**
 * First day of a rolling window of `days` calendar days ending with (and including) `day`.
 * Calendar arithmetic in UTC, so DST never shifts it.
 * @param day - YYYY-MM-DD
 * @param days - >= 1
 */
export declare function windowStart(day: string, days: number): string;
/**
 * Adds `pending` to `days[today]` (creating it), zeroes `pending` in place, drops every day outside
 * [purgeBefore, today], and returns each remaining day as a stats_put row (copies, so later folds
 * never change a queued write). Mutates `days` and `pending`.
 * @param today - YYYY-MM-DD
 * @param purgeBefore - YYYY-MM-DD
 */
export declare function foldPending(days: Record<string, Counters>, pending: Counters, today: string, purgeBefore: string): (Counters & {
    day: string;
})[];
/**
 * The /headroom tables as rows of cells. Each table starts with its header row (heading, then the column names), then one row per ROWS entry.
 * A row without counters (still loading, storage off or failing) shows `blank` in every value cell. The in-memory session-only
 * counters add a `subagents` row under effort routing's session row, and the smart crusher, dedup, line elider, compaction,
 * config, html extractor, logs, search, diff, text crusher and relevance split tables, which have only a session row.
 * @param counters - one per ROWS entry, in ROWS order
 * @returns effort routing, cache aligner, smart crusher, dedup, line elider, compaction, config, html extractor,
 *   logs, search, diff, text crusher, relevance split
 */
export declare function statsTables(counters: readonly (Row | undefined)[], blank: string, memory?: StatsMemory): string[][][];
/**
 * One table as plain text: the label column padded on the right, the value columns right-aligned.
 */
export declare function tableText(rows: readonly (readonly string[])[]): string;
/**
 * Upstream compute_optimal_k (bias 1; the crusher's min_k 3, max_k 15 by default): how many items to keep, from simhash
 * diversity and the knee of the items' bigram coverage curve. As upstream, 8 or fewer items keep them all, even above maxK.
 * @param itemStrings - each item's text (a row's compact JSON, a log line, a search match)
 * @param budget - charged 1 per simhash comparison; exhausted means maxK
 */
export declare function computeOptimalK(itemStrings: readonly string[], minK?: number, maxK?: number, budget?: WorkBudget): number;
/**
 * Stores offloaded originals for headroom_retrieve: a re-put moves its hash to the newest position, and the
 * oldest entries go while the store holds more than CCR_CAPACITY entries or CCR_MAX_CHARS characters. Never an entry
 * of `entries` itself: the row that carries their markers is stored next, so a batch may leave the store over a cap until
 * the next call with entries. Mutates `store`.
 * shortcut: no idle TTL (upstream: 30 min); add one with a time argument from register.ts if memory becomes a concern.
 * @param store - hash → original text (a crushed array's JSON, an elided block, a folded span), oldest first
 */
export declare function storeOffloaded(store: Map<string, string>, entries: readonly [string, string][]): void;
/**
 * The CCR key in what the model passed to headroom_retrieve: the bare hash, or one copied with its marker's `hash=` or
 * `<<ccr:` prefix (the tool's description cites both forms) and, as a pointer or elider line ends in `]` and a CCR
 * marker in `>>`, that closing bracket. Anything else is returned trimmed, as is.
 * @returns undefined unless `hash` is a string
 */
export declare function retrieveKey(hash: unknown): string | undefined;
/**
 * The crusher's query (upstream _extract_context_from_messages): newest first, the text of the last five
 * user messages with text and each assistant tool call's input JSON. Deviation: upstream counts every user message,
 * but a Claude Code tool result is a user message with empty text, so the real request would age out after five calls.
 * Deviation: the tool-call inputs keep at most CRUSH_QUERY_INPUT_CHARS characters in all, newest first. A subagent has
 * one user message, so the walk would otherwise stringify every input back to its start on each JSON result.
 * @param messages - chronological, as the session.messages op returns them
 */
export declare function crushQuery(messages: readonly QueryMessage[]): string;
/**
 * Upstream HybridScorer::score_batch without embeddings (bm25Batch), then the BM25-only boost: a match scores at least 0.3,
 * two or more add 0.2. Only selective query tokens (isSelective) count as matches.
 * @param docs - each row's compact JSON
 * @returns one score per row, 0..1
 */
export declare function relevanceScores(docs: readonly string[], query: string): number[];
/**
 * Upstream BM25Scorer.score_batch's plain scores (TextCrusher's and the relevance split's relevance): bm25Batch over every
 * query term, no selective filter and no boost. An empty query scores every document 0.
 * @returns one score per document, 0..1
 */
export declare function bm25Scores(docs: readonly string[], query: string): number[];
/**
 * Upstream compact_inner (TabularCompactor) with opaque markers off: 2+ objects become a table, or buckets when under 60% of
 * the keys are in 80% of the rows and a discriminator splits them; anything else stays untouched. Deviation: a key holding
 * `,` `:` `{` `}` `?` or a line break leaves the items untouched, and an exhausted work budget (key reads plus table cells)
 * does too. Keys sort by UTF-16 code units where upstream's BTreeMap sorts UTF-8 bytes.
 * @param budget - unbounded when absent
 */
export declare function compactRows(items: readonly unknown[], budget?: WorkBudget): Compaction;
/**
 * Upstream CsvSchemaFormatter (include_drop_summary false): a table, `__buckets:<disc>` then `__key:<value>` and a table per
 * bucket, or an untouched value as compact JSON. Field names are not escaped (upstream's documented exposure; compactRows
 * refuses the names that would break the header).
 */
export declare function formatCsvSchema(c: Compaction): string;
/**
 * Upstream compaction_to_json (the JSON a nested cell renders as), key order as upstream: a missing cell reads null.
 */
export declare function compactionJson(c: Compaction): unknown;
/**
 * Python round / Rust round_ties_even: the nearest integer, a tie going to the even one.
 */
export declare function roundHalfEven(x: number): number;
/**
 * Upstream crush_string_array: 8 or fewer items pass through; otherwise every error-keyword item, every length anomaly (code
 * points more than 2 sample σ from the mean) and the first and last K items stay, and a stride over the rest tops the kept set up
 * to K plus the errors and anomalies, skipping exact repeats of a kept string. The kept items keep their order.
 * @returns `items` itself when nothing was dropped
 */
export declare function crushStringArray(items: readonly string[]): readonly string[];
/**
 * Upstream crush_number_array's change points: with more than 10 numbers, each index i in 5..n−6 where the means of the 5 numbers
 * before and the 5 from i differ by more than 2σ (`sd`). Unlike changePoints (the dict analyzer's), no minimum spacing.
 * @param sd - the sample standard deviation of `items`
 */
export declare function numberChangePoints(items: readonly number[], sd: number): number[];
/**
 * Upstream crush_number_array without its strategy string: 8 or fewer items pass through; otherwise every outlier (more than 2
 * sample σ from the mean), every change point and the first and last K numbers stay, and a stride tops the kept set up to K plus
 * the outliers. The kept numbers keep their order.
 * @returns `items` itself when nothing was dropped
 */
export declare function crushNumberArray(items: readonly number[]): readonly number[];
/**
 * SmartCrusher over one JSON document (upstream smart_crush_content): with `modes.lossless`, a dict array whose csv-schema
 * table saves 15% becomes that table as a string (a top-level array yields a JSON string literal, upstream's wrapper); with
 * `modes.lossy`, dict arrays lose rows to a `{"_ccr_dropped":"<<ccr:HASH N_rows_offloaded>>"}` sentinel. The result is compact
 * JSON. Undefined means pass the text through: at most CRUSH_MIN_CHARS, not a JSON object or array, a number, -0 or duplicate
 * key JSON.parse cannot keep, nothing changed, or output that is not shorter (a table's `\n` escapes can fail this after it
 * passed the 15% gate, as upstream). Deviation: upstream also minifies a pretty-printed document that lost no rows; here such
 * a result keeps its original bytes.
 * @param query - the conversation context (crushQuery), "" for none
 * @param modes - the lossy path alone when absent
 */
export declare function crushJson(text: string, query: string, modes?: CrushModes): CrushOutcome | undefined;
/**
 * Dense line elider (upstream dense_line_elider.py + ContentRouter._elide_dense): each long, nearly space-free line that
 * holds no JSON document keeps its first 160 and last 80 characters around an omission note, when the dense lines add
 * up to at least 2000 characters; the block then ends with a retrieval line and its original goes to the CCR store.
 * A line a tag span touches is never dense (the tag protector, a mod-side guard). Undefined when nothing is dense or the
 * result is not shorter.
 * @param spans - tagSpans(text), none when absent
 */
export declare function elideDense(text: string, spans?: readonly [number, number][]): Elision | undefined;
/**
 * Empties a conversation's dedup corpus and keeps its ordinal counter, so a later pointer's "result N" never repeats
 * the number of a result that left the corpus. Mutates `st`.
 */
export declare function resetCorpus(st: DedupState): void;
/**
 * Cross-turn dedup (upstream cross_turn_dedup.py) for one tool-result text appended to conversation `key`: each run of
 * at least 3 lines and 40 characters found verbatim (or under one uniform line-number shift) in an earlier block of the
 * same conversation becomes a pointer naming that block's ordinal, with the run's own text stored under a CCR hash.
 * A protected text is only indexed. A line a tag span touches never starts a run and ends one before it (the tag protector,
 * a mod-side guard), but is indexed like any other. The block is then indexed, and the oldest conversations are emptied
 * (resetCorpus, their ordinals kept) while all corpora hold more than DEDUP_MAX_CHARS. Mutates `states`. Undefined when
 * nothing folded.
 * @param states - conversation key → corpus, least recently appended first
 * @param key - "" for the main loop, else the agentId
 * @param spans - tagSpans(text), none when absent
 */
export declare function dedupBlock(states: Map<string, DedupState>, key: string, text: string, isProtected: boolean, spans?: readonly [number, number][]): Fold | undefined;
/**
 * Upstream _INI_ASSIGN_RE (`^\s*[\w.\-@ ]+?\s*[=:]\s*`) as a linear scanner: before the first `=` or `:` stand optional
 * whitespace, a run of word characters, `.`, `-`, `@` and spaces, and optional whitespace. The regex's lazy run plus `\s*`
 * backtracks quadratically on whitespace-heavy lines.
 */
export declare function isIniAssign(line: string): boolean;
/**
 * Upstream _try_detect_structured_config's verdict: a section header plus an assignment-dominant body is TOML when every
 * assignment is a TOML key with a TOML value, else INI when every one is an INI assignment (deviation: line checks stand in
 * for tomllib and configparser); otherwise YAML by key, list and document-marker share with the prose, front-matter and
 * structure guards. Runs over the first 200 sampled lines.
 * @param head - the line-capped sample lines (detectHead)
 */
export declare function configFlavor(text: string, head: readonly string[]): ConfigFlavor | undefined;
/**
 * The tag protector (upstream tag_protector.rs identify_spans in block mode, compress_tagged_content off): the [start, end)
 * ranges of every custom (non-HTML5, case-insensitive) tag block `<name …>…</name>`, nested ones collapsed into the outermost,
 * and of every self-closing custom tag `<name/>`. A close matches the top-most open of its name; an orphan close or open is
 * never protected. Deviation: the content of an HTML5 `<svg>` or `<math>` element is not scanned (SVG and MathML children
 * are no workflow tags; an unclosed one skips nothing). The scanned characters and every stack entry a close examines share a budget of 4 per character
 * + 4096; null when it runs out, and such a text must be passed through whole (upstream walks without a bound).
 * @returns sorted, disjoint spans; null when the text is unprotectable
 */
export declare function tagSpans(text: string): [number, number][] | null;
/**
 * The HTML extractor (a bounded, hand-written stand-in for upstream's trafilatura HTMLExtractor): one forward pass that skips
 * comments, `<!…>` / `<?…>` declarations and boilerplate or non-text elements (HTML_DROP, open tag to its close tag, or to the
 * end when unclosed), and renders the rest as markdown-ish text: `#` headings, `- ` list items, `[text](href)` links (not `#…`
 * or `javascript:`), `| ` table cells, a line per block element, whitespace kept only inside `<pre>`, entities decoded. The
 * whole pass draws on a budget of 4 per character + 4096. Undefined when the budget runs out, nothing is left (upstream
 * #3609: fall through, never discard) or the result with its retrieval line is not shorter; else the extraction plus
 * `[HTML extracted to text: N characters of markup removed. Retrieve original: hash=H]`, the original under `offloaded`.
 */
export declare function extractHtml(text: string): {
    text: string;
    offloaded: [string, string][];
} | undefined;
/**
 * Upstream detect_content_type's tag: the category set and branch order of content_detector.rs, each branch's
 * heuristics and thresholds from content_detector.py, plus Python's structured-config branch in its place (after log, before
 * code; the tabular branch Python checks in between stays omitted). Pure; never throws.
 * @param text - a tool-result text
 */
export declare function detectContentType(text: string): ContentType;
/**
 * Upstream collapse_runs: 2+ identical consecutive lines become the line once plus `... (repeated N times)`.
 */
export declare function collapseRuns(text: string): string;
/**
 * Upstream expand_runs (collapseRuns' exact inverse). Deviation: gives up once the output would pass `maxLines`, so a marker
 * with a huge count in the input never allocates it.
 * @returns undefined past maxLines
 */
export declare function expandRuns(text: string, maxLines?: number): string | undefined;
/**
 * Upstream fold_repeated_blocks: a run of K >= 3 lines that repeats the K lines D lines back (K <= D, original coordinates)
 * becomes `... (repeats K lines from D lines back)` when its characters exceed the marker's; at most 8 recent positions per
 * distinct line and 64 lines per block are tried, and a text under 6 or over 20,000 lines is left alone.
 */
export declare function foldRepeatedBlocks(text: string): string;
/**
 * Upstream unfold_repeated_blocks (foldRepeatedBlocks' exact inverse); a marker it could not have emitted (K > D, or reaching
 * before the start) stays as is. Deviation: gives up once the output would pass `maxLines`, so nested markers in the input
 * never double it repeatedly.
 * @returns undefined past maxLines
 */
export declare function unfoldRepeatedBlocks(text: string, maxLines?: number): string | undefined;
/**
 * Upstream compact_lossless(text, "config"): single-line runs, then repeated stanzas; kept only when the inverse gives the text
 * back exactly and the result is shorter.
 */
export declare function compactConfigLossless(text: string): string;
/**
 * Upstream ConfigCompressor.compress without Tier 3 (the TOML schema fold): Tier 2 drops whole-line comments and blank lines
 * behind `[N comment/blank lines elided. Retrieve original: hash=H]` (the original goes to `offloaded`), then Tier 1 folds
 * repeated lines and stanzas losslessly. Undefined when the text is no structured config or nothing was saved.
 */
export declare function compressConfig(text: string): {
    text: string;
    offloaded: [string, string][];
} | undefined;
/**
 * The log fold (upstream compact_lossless "log"): ANSI colour dropped one-way, then runs of identical lines collapsed to
 * `... (repeated N times)`, kept only when it expands back to the de-coloured text and is shorter than the input.
 */
export declare function foldLog(text: string): {
    text: string;
    offloaded: [string, string][];
} | undefined;
/**
 * Upstream LogCompressor::compress_with_store with its default config: a log of 50+ lines keeps its errors, failures,
 * deduplicated warnings, stack traces, summary lines and their context, up to an adaptive 10 to 100 lines, plus the omitted-lines
 * summary, then `[N lines compressed to M<descriptor>. Retrieve original: hash=H]` with the input stored under H. Deviations:
 * the retrieval line is always added ("Retrieve original", no 0.5 ratio gate), the hash is contentHash, the simhash diversity
 * count is budgeted (an exhausted budget keeps 100), and the format detector (cosmetic) is not ported. Undefined under 50
 * lines or when the result is not shorter.
 */
export declare function compressLog(text: string): {
    text: string;
    offloaded: [string, string][];
} | undefined;
/**
 * The search fold (upstream compact_lossless "search"): the file-heading and directory-heading folds, each kept only when its
 * inverse gives the text back exactly; the smaller one wins when it is shorter than the text.
 */
export declare function foldSearch(text: string): {
    text: string;
    offloaded: [string, string][];
} | undefined;
/**
 * Upstream SearchCompressor::compress_with_store with its default config: grep/ripgrep rows (matches and `-C` context lines
 * alike) parsed by file, scored (+0.3 per query context word in the line, +0.5 an error word, +0.3 an importance word, else
 * +0.4 a warning word, at most 1), the 15 best-scoring files kept, then per file its first, last and best matches up to 5 and
 * an adaptive 5 to 30 in all, in path and line order with `[... and N more matches in FILE]`, then
 * `[N matches compressed to M. Retrieve original: hash=H]` with the input stored under H. Lines that do not parse are dropped,
 * as upstream. Deviations: the retrieval line is always added ("Retrieve original", no match-count or ratio gate), the hash is
 * contentHash, context words are capped (contextWords) and CJK query bigrams are not added, and the parse's path checks and
 * the simhash count are budgeted (an exhausted parse declines), and a text holding a compiler or linter diagnostic row
 * (DIAGNOSTIC_ROW_RE) declines. Undefined when nothing parses or the result is not shorter.
 * @param query - the conversation context (crushQuery), "" for none
 */
export declare function compressSearch(text: string, query: string): {
    text: string;
    offloaded: [string, string][];
} | undefined;
/**
 * The diff fold (upstream compact_lossless "diff"): `index <sha>..<sha> [mode]` lines dropped, when that shortens the text. No
 * inverse check, as upstream; the router only calls it on diff-labelled text.
 */
export declare function foldDiff(text: string): {
    text: string;
    offloaded: [string, string][];
} | undefined;
/**
 * Upstream DiffCompressor::compress_with_store with its default config: a diff of 50+ lines keeps its pre-diff lines, at most 20
 * files (past 20 the most-changed, in that order), per file at most 10 hunks (the first, the last and the best-scored middle
 * ones) trimmed to 2 context lines around each change, with mode lines normalised to 100644 and binary lines to `Binary files
 * differ`, then `[N files changed, +A -D lines, H hunks omitted]` and `[N lines compressed to M. Retrieve original: hash=H]`
 * with the input stored under H. Deviations: the retrieval line is always added ("Retrieve original", no 0.8 line-ratio gate,
 * so a result is returned only when shorter), the hash is contentHash, hunks are scored only when a file has more than 10 (the
 * score is read nowhere else), and context words are deduped and capped. Undefined under 50 lines, without a file header, or
 * when the result is not shorter.
 * @param query - the conversation context (crushQuery), "" for none
 */
export declare function compressDiff(text: string, query: string): {
    text: string;
    offloaded: [string, string][];
} | undefined;
/**
 * Whether a text reads as prose: at least half its non-empty lines hold a sentence end (`.`, `!` or `?` before whitespace or
 * the line end). Deviation (user decision): the text crusher and the relevance split run only on prose, since upstream's
 * one-segment-per-line fallback would halve a Glob, find, ls or `git log --oneline` listing. One linear pass.
 */
export declare function isProse(text: string): boolean;
/**
 * The text fold (upstream compact_lossless "text"): runs of identical lines collapsed to `... (repeated N times)`, kept only when
 * it expands back to the text and is shorter.
 */
export declare function foldText(text: string): {
    text: string;
    offloaded: [string, string][];
} | undefined;
/**
 * Upstream TextCrusher::compress (the ASCII path, default config): prose split into sentence segments, each scored by recency
 * (1.0 × (i+1)/n), BM25 relevance to the query (2.0 ×) and salience (1.5 × salient words / (words + 1)), × 0.25 under 12 chars;
 * then, best first, segments are kept until half the characters are, skipping one whose 3-token shingles are 85% covered by kept
 * ones. The kept segments, in order and joined by \n, end with `[Text crushed: K of N segments kept. Retrieve original: hash=H]`
 * and the input is stored under H. Deviations: text holding a CJK character declines (upstream's ICU path is not ported), lengths
 * count UTF-16 units where upstream counts UTF-8 bytes, and the retrieval line is the mod's own. Undefined under 6 segments or
 * when the result is not shorter.
 * @param query - the conversation context (crushQuery), "" for none
 */
export declare function crushText(text: string, query: string): {
    text: string;
    offloaded: [string, string][];
} | undefined;
/**
 * Upstream segment(content, window, max_chars): a lossless partition (`segs.join("") === text`) into blank-line-delimited
 * blocks, each packed into windows of at most `window` lines, an indented continuation line held past that, and at most
 * `maxChars` characters; a single longer line stays whole. Deviation: lines split on \n only (Python's splitlines also splits on
 * \r, \v, \f, \x1c-\x1e, \x85, U+2028 and U+2029).
 */
export declare function segmentRecords(text: string, window?: number, maxChars?: number): string[];
/**
 * Upstream _otsu_threshold: the midpoint of the adjacent sorted pair that maximises the between-class variance.
 * @param values - at least one
 */
export declare function otsuThreshold(values: readonly number[]): number;
/**
 * Upstream adaptive_threshold: `floor` when fewer than 2 distinct values remain after rounding to 9 decimals, else the Otsu cut
 * of the raw values, at least `floor`.
 */
export declare function adaptiveThreshold(values: readonly number[], floor: number): number;
/**
 * Upstream plan_relevance_split plus content_router.py _relevance_split_compress, for prose: the text's records
 * (segmentRecords) are scored by plain BM25 against the query and kept from the adaptive cut (floor 0.25) up; consecutive
 * records of one disposition form runs. A DROP run holding an ERROR_KEYWORDS line is kept whole (user decision). Each DROP run
 * becomes `...[N low-relevance line(s) elided]...` (upstream's CCR-mode disposition: the mod always has retrieval), KEEP runs
 * are folded with foldText while `foldOn` (text_crusher_enabled owns that fold; off, they stay raw and foldText is never
 * called), and `[N low-relevance line(s) in R run(s) elided. Retrieve original: hash=H]` ends the text, the input stored under H.
 * Adopted only when strictly shorter than the baseline: foldText's whole-text fold while `foldOn` (or the text when it
 * declines), else the text. Undefined for an empty query, a single record, a multi-line bracket span across a cut, no KEEP run
 * (never an all-DROP output; user decision) or no DROP run.
 * @param query - the conversation context (crushQuery)
 * @param foldOn - whether the text crusher's lever, the owner of foldText, is on
 */
export declare function splitRelevance(text: string, query: string, foldOn: boolean): {
    text: string;
    offloaded: [string, string][];
} | undefined;
/**
 * Whether a tool-result row holds text a query-reading lever may rewrite, so the hook pays the transcript fetch only then:
 * a JSON document for the SmartCrusher, or, for the search and diff compressors, the text crusher and the relevance split,
 * any non-Read text of at least ROUTE_MIN_CHARS. A cheap pre-check: no content detection. The default levers are the
 * two-argument call's (the SmartCrusher alone).
 * @param content - the row's blocks
 * @param tool - the row's origin tool
 * @param levers - the row's levers; only crush and the query-reading prose levers count
 */
export declare function wantsQuery(content: readonly ContentBlock[], tool: string, levers?: {
    crush?: boolean;
    log?: boolean;
    search?: boolean;
    diff?: boolean;
    textcrush?: boolean;
    split?: boolean;
}): boolean;
/**
 * Rewrites a tool-result row's blocks before they are stored: per tool_result block, each text runs its content type's
 * route (`detectContentType`, `ROUTES`): crushed (one whole JSON document) or else dense-line-elided, then a single-text
 * result is deduplicated against earlier results of the same conversation. Error blocks and headroom_retrieve /
 * own-storage rows are never rewritten (dedup still indexes them). Undefined when no block changed. Mutates
 * levers.dedup.states; a throw starts that conversation's corpus over, since a block indexed before it belongs to a row
 * that is then stored as made.
 * @param content - the row's blocks
 * @param tool - the row's origin tool
 * @param query - the conversation context (crushQuery), "" for none
 */
export declare function rewriteToolResults(content: readonly ContentBlock[], tool: string, levers: Levers, query: string): RowRewrite | undefined;
export {};
