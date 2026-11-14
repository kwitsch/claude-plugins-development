/**
 * Actions Jev may take itself. Code builds the list; Jev only picks from it, so every argument is a known value and
 * never generated text. Pure: `buildCandidates` and `packageRunner` (filesystem, command and tool lists) live in
 * `register.mts` and use the exported constants and helpers below.
 *
 * @packageDocumentation
 */
import { head } from "./context.mjs";

/** One action Jev may take. */
export type Candidate = {
  /** Option key shown to Jev, e.g. `read src/app.ts` or `run npm test`. */
  key: string;
  /** What the action does, for Jev. */
  description: string;
  /** The tool that carries it out. */
  tool: "Read" | "Bash" | "Skill" | "ToolSearch";
  /** The tool input. */
  input: Record<string, unknown>;
};

/** How many file reads a turn may be offered. */
export const MAX_READS = 8;
/** How many mentioned paths one candidate build may stat that the turn has not statted yet (missing paths do not count towards {@link MAX_READS}). */
export const MAX_STATS = 16;
/** How many quoted-term searches a turn may be offered. */
const MAX_SEARCHES = 3;
/** package.json script names that may run unasked if no word of them is in {@link UNSAFE_WORD}. */
const SCRIPT_HEAD = /^(?:test|tests|lint|build|typecheck|type-check|check|test:[\w:-]+|lint:[\w:-]+)$/;
/** Script name words (lowercased) that rewrite files (`fix`, `autofix`, `update`, `u`) or never exit (`watch`, `dev`, `ui`, `open`, `debug`). */
const UNSAFE_WORD = /^(?:(?:auto)?fix|write|format|update|u|watch|dev|serve|ui|open|debug)$/;

/**
 * Whether a package.json script is safe to run unasked.
 *
 * @param name - The script name.
 * @returns True for an allowlisted name none of whose words (split at `:`, `-`, `_` and camelCase humps, also after an acronym run as in `CSSFix`) is in {@link UNSAFE_WORD}.
 */
export function isSafeScript(name: string): boolean {
  return SCRIPT_HEAD.test(name) && !name.split(/[:_-]|(?<=[a-z\d])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/).some((w) => UNSAFE_WORD.test(w.toLowerCase()));
}
/**
 * Built-in CLI commands the command list can report as user commands but the Skill tool refuses (`/diff` did).
 * Failed skills are also blocklisted at run time.
 */
export const BUILTIN_COMMANDS = new Set(
  ("add-dir agents bug clear compact config context cost diff doctor exit export help hooks ide init "
    + "install-github-app login logout mcp memory model permissions plugin pr-comments release-notes resume "
    + "review rewind status statusline terminal-setup theme upgrade usage vim").split(" "),
);

/** The store key of the skills the Skill tool refused. */
export const SKILL_BLOCKLIST_KEY = "skillBlocklist";

/** Makefile targets safe to run unasked. */
export const SAFE_MAKE = /^(test|tests|check|lint|build|typecheck)$/;
/** Paths like src/app.ts, ./README.md, /abs/x.json: something with a file extension, also at a sentence end (`src/app.ts.`, `src/app.ts?`). */
const PATH = /(?:^|[\s`'"([])((?:~|\.{1,2})?\/?[\w@.-]+(?:\/[\w@.-]+)*\.[A-Za-z][A-Za-z0-9]{0,7})(?=[.?!]*(?:$|[\s`'"),:;\]]))/g;
/** Terms the user quoted: `useAuth`, "TODO: fix". */
const QUOTED = /`([^`\n]{3,60})`|"([^"\n]{3,60})"/g;

/**
 * File paths mentioned in `texts`, deduplicated, without versions, URLs and `..` paths.
 *
 * @param texts - The request and the turn's texts.
 * @param seen - Paths found by earlier calls of the turn, extended here (a fresh set by default).
 * @returns The paths as written, the earlier ones first.
 */
export function mentionedPaths(texts: readonly string[], seen: Set<string> = new Set()): string[] {
  for (const text of texts) {
    const spans = [...text.matchAll(QUOTED)].map((q) => [q.index, q.index + q[0].length] as const);
    for (const m of text.matchAll(PATH)) {
      const p = m[1];
      const start = m.index + m[0].length - p.length;
      // A match after whitespace inside a quoted span is the tail of a name with a space (`"docs/my notes.md"`), not a path of its own.
      if (spans.some(([a, b]) => start > a && start < b && /\s/.test(text.slice(a + 1, start)))) continue;
      if (/^\d/.test(p) || /^https?:/.test(p) || p.includes("..")) continue;
      seen.add(p);
    }
  }
  return [...seen];
}

/**
 * Terms the user quoted that are not file names, at most {@link MAX_SEARCHES}.
 *
 * @param text - The request.
 * @returns The terms.
 */
export function quotedTerms(text: string): string[] {
  const seen = new Set<string>();
  for (const m of text.matchAll(QUOTED)) {
    const term = (m[1] ?? m[2] ?? "").trim();
    if (term.length >= 3 && !term.includes("'") && !/^[\w./@~-]+\.[A-Za-z]{1,8}$/.test(term)) seen.add(term);
  }
  return [...seen].slice(0, MAX_SEARCHES);
}

/**
 * Never offered for reading: Claude Code's temp and task folders (a subagent's `.output` file is its whole
 * transcript and floods the context), system temp dirs, and Claude's own config tree.
 */
const UNSAFE_PATH = /(^|\/)(tmp|private\/tmp|private\/var\/folders|var\/folders)\/|\/\.claude\/|\/tasks\/[^/]+\.output$|\.output$|\.jsonl$/i;
/**
 * Inside the project only transcripts are refused, so a project that lives in a temp dir (a scratch copy, a
 * benchmark) can still be read.
 */
const TRANSCRIPT = /\/tasks\/[^/]+\.output$|\.output$|\.jsonl$/i;
/**
 * Claude's own config and credentials (`~/.claude.json` with MCP env values, the OAuth token file, settings,
 * project memory), refused wherever the cwd is, also when the project is `$HOME` itself. Suffixed copies
 * (`settings.json.bak`, `.claude.json~`) hold the same secrets and are refused too. All three patterns ignore case:
 * on APFS, Windows and WSL `/mnt/c` any capitalisation (`.CLAUDE.json`) opens the same file.
 */
const CLAUDE_CONFIG = /\/\.claude\.json(?:$|[.~-])|\/\.claude\/(?:projects\/|(?:\.credentials|settings(?:\.local)?)\.json(?:$|[.~-]))/i;
/**
 * Whether a file may be offered as a Read candidate: never one with a `..` segment, which can leave the project
 * while still starting with the cwd.
 *
 * @param file - The absolute path.
 * @param cwd - The project directory.
 * @returns Whether it is safe to offer.
 */
export const isSafeToOffer = (file: string, cwd?: string): boolean => !/(^|\/)\.\.(\/|$)/.test(file) && !CLAUDE_CONFIG.test(file) && (cwd && file.startsWith(`${cwd}/`) ? !TRANSCRIPT.test(file) : !UNSAFE_PATH.test(file));

/**
 * `p` as an absolute path under `cwd`, with `.` segments removed, so spellings of one file compare equal.
 *
 * @param cwd - The project directory.
 * @param p - A path as written.
 * @returns The absolute path.
 */
export const absolute = (cwd: string, p: string): string => (p.startsWith("/") ? p : `${cwd}/${p}`).replace(/\/(?:\.\/)+/g, "/");

/** A tool call, for comparison. */
type Call = { tool: string; input: Record<string, unknown> };

/**
 * Whether two calls are the same action, by the argument that matters per tool.
 *
 * @param a - One call.
 * @param b - The other.
 * @returns Whether they are the same.
 */
export function sameCall(a: Call, b: Call): boolean {
  if (a.tool !== b.tool) return false;
  if (a.tool === "Read") return a.input.file_path === b.input.file_path;
  if (a.tool === "Bash") return String(a.input.command).trim() === String(b.input.command).trim();
  if (a.tool === "Skill") return a.input.skill === b.input.skill;
  if (a.tool === "ToolSearch") return a.input.query === b.input.query;
  return false;
}

/**
 * A Bash candidate.
 *
 * @param command - The command to run.
 * @param description - What it shows.
 * @returns The candidate.
 */
export const bash = (command: string, description: string): Candidate => ({
  key: `run ${command}`,
  description,
  tool: "Bash",
  input: { command, description },
});

/** MCP sign-in tools are never the next step of a coding turn. */
export const AUTH_TOOL = /__(authenticate|complete_authentication)$/;
/** How many related skills or tools a turn may be offered. */
const MAX_RELATED = 8;
/** Words too common in prompts and skill descriptions to show a relation. */
const STOPWORDS = new Set(
  ("the and for with this that these those when what which where how why who any all can could would should will "
    + "you your use used using user users from into onto about over than then them they its it's are was were has have "
    + "had not but also only just some more most very like want need make made create new get set show see one two "
    + "file files read run runs tool tools skill skills command commands claude code project before after first step "
    + "please let lets now ok okay yes here there out other each every such via per our we me my is be to of in on at "
    + "an a or do does did done if so as by up no").split(" "),
);

/**
 * Lowercase content words, light-stemmed so changes/changed/change match. NFC-normalized and split only at
 * characters that are no letter, combining mark or digit, so NFD umlauts and vowel signs stay inside their words.
 *
 * @param text - Any text.
 * @returns The content words.
 */
export function words(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.normalize("NFC").toLowerCase().split(/[^\p{L}\p{M}\p{N}]+/u)) {
    if (w.length < 3 || STOPWORDS.has(w) || /^\d+$/.test(w)) continue;
    const stem = w.replace(/(ing|ed|es|e|s)$/, "");
    out.add(stem.length >= 3 && !w.endsWith("ss") ? stem : w);
  }
  return out;
}

/**
 * Skills and tools whose name or description shares words with the prompt, best first. A name word counts double;
 * one description word alone is not enough, so generic overlaps ("document", "video") need a second word.
 *
 * @typeParam T - A named, described item.
 * @param prompt - The request.
 * @param items - The skills or tools.
 * @returns The related items, at most {@link MAX_RELATED}.
 */
export function relevant<T extends { name: string; description: string }>(prompt: string, items: readonly T[]): T[] {
  const want = words(prompt);
  if (!want.size) return [];
  const scored = items.map((item) => {
    const name = words(item.name.replace(/^mcp__/, "").replace(/[_:]+/g, " "));
    const desc = words(item.description);
    let score = 0;
    // The item's few words, not the prompt's: a pasted log has 100k distinct words (prompt x items took 1.7 s at 2 MB). A word in both name and description counts once, as 2.
    for (const w of name) if (want.has(w)) score += 2;
    for (const w of desc) if (want.has(w) && !name.has(w)) score += 1;
    return { item, score };
  });
  return scored
    .filter((s) => s.score >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_RELATED)
    .map((s) => s.item);
}

/**
 * One entry per skill: `anthropic-skills:pdf` and `pdf`, or `youtube-metadata` and
 * `youtube-plugin:youtube-metadata`, are the same skill listed twice. The unprefixed name wins.
 * A prefixed name collapses only onto a listed unprefixed one: `git-tools:review` and `docs-kit:review`
 * are different skills and both stay.
 *
 * @typeParam T - A named item.
 * @param skills - The listed skills.
 * @returns The skills without duplicates.
 */
export function dedupeSkills<T extends { name: string }>(skills: readonly T[]): T[] {
  const bare = new Set(skills.filter((s) => !s.name.includes(":")).map((s) => s.name));
  const base = (n: string) => {
    const b = n.slice(n.lastIndexOf(":") + 1);
    return bare.has(b) ? b : n;
  };
  const byBase = new Map<string, T>();
  for (const s of skills) {
    const kept = byBase.get(base(s.name));
    if (!kept || (kept.name.includes(":") && !s.name.includes(":"))) byBase.set(base(s.name), s);
  }
  return skills.filter((s) => byBase.get(base(s.name)) === s);
}

/**
 * A script or description cut to 80 characters for an option description.
 *
 * @param s - The text.
 * @returns The clipped text.
 */
export const clipScript = (s: string): string => (s.length > 80 ? `${head(s, 80)}…` : s);
