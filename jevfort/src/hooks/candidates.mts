/**
 * Actions Jev may take itself. Code builds the list; Jev only picks from it, so every argument is a known value and
 * never generated text. Pure: `buildCandidates` and `packageRunner` (filesystem, command and tool lists) live in
 * `register.mts` and use the exported constants and helpers below.
 *
 * @packageDocumentation
 */

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
/** How many quoted-term searches a turn may be offered. */
const MAX_SEARCHES = 3;
/** package.json script names safe to run unasked. */
export const SAFE_SCRIPT = /^(test|tests|lint|build|typecheck|type-check|check|test:[\w:-]+|lint:[\w:-]+)$/;
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
/** Paths like src/app.ts, ./README.md, /abs/x.json: something with a file extension. */
const PATH = /(?:^|[\s`'"([])((?:~|\.{1,2})?\/?[\w@.-]+(?:\/[\w@.-]+)*\.[A-Za-z][A-Za-z0-9]{0,7})(?=$|[\s`'"),:;\]])/g;
/** Terms the user quoted: `useAuth`, "TODO: fix". */
const QUOTED = /`([^`\n]{3,60})`|"([^"\n]{3,60})"/g;

/**
 * File paths mentioned in `texts`, deduplicated, without versions, URLs and `..` paths.
 *
 * @param texts - The request and the turn's texts.
 * @returns The paths as written.
 */
export function mentionedPaths(texts: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const text of texts) {
    for (const m of text.matchAll(PATH)) {
      const p = m[1];
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
const UNSAFE_PATH = /(^|\/)(tmp|private\/tmp|private\/var\/folders|var\/folders)\/|\/\.claude\/|\/tasks\/[^/]+\.output$|\.output$|\.jsonl$/;
/**
 * Inside the project only transcripts are refused, so a project that lives in a temp dir (a scratch copy, a
 * benchmark) can still be read.
 */
const TRANSCRIPT = /\/tasks\/[^/]+\.output$|\.output$|\.jsonl$/;
/**
 * Whether a file may be offered as a Read candidate.
 *
 * @param file - The absolute path.
 * @param cwd - The project directory.
 * @returns Whether it is safe to offer.
 */
export const isSafeToOffer = (file: string, cwd?: string): boolean => (cwd && file.startsWith(`${cwd}/`) ? !TRANSCRIPT.test(file) : !UNSAFE_PATH.test(file));

/**
 * `p` as an absolute path under `cwd`.
 *
 * @param cwd - The project directory.
 * @param p - A path as written.
 * @returns The absolute path.
 */
export const absolute = (cwd: string, p: string): string => (p.startsWith("/") ? p : `${cwd}/${p.replace(/^\.\//, "")}`);

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
 * What a shell command does, for comparison: each `&&`/`;`/newline part, cut at its first pipe (`| tail`,
 * `| grep` only filter the output), without redirections, `cd` and `echo`, reduced to its command words (flags,
 * paths and numbers dropped). `git status; git diff --stat 2>&1 | head` and `git status --short && git diff --stat`
 * both give `git diff|git status`.
 *
 * @param command - The shell command.
 * @returns The sorted command words joined by `|`.
 */
export function commandKey(command: string): string {
  const parts = new Set<string>();
  for (const raw of command.split(/&&|\|\||;|\n/)) {
    const seg = raw.split(/(?<!\|)\|(?!\|)/)[0].replace(/\d?>&\d|\d?>\s*\/dev\/null/g, "").trim();
    if (!seg || /^(cd|echo|printf|set|export)\b/.test(seg)) continue;
    const tokens = seg.split(/\s+/);
    const words = [tokens[0], ...tokens.slice(1).filter((t) => /^[a-z][\w:-]*$/.test(t))];
    parts.add(words.slice(0, words[1] === "run" || words[1] === "exec" ? 3 : 2).join(" "));
  }
  return [...parts].sort().join("|");
}

/**
 * Same action: identical, or for shell commands the same `commandKey`.
 *
 * @param a - One call.
 * @param b - The other.
 * @returns Whether they are equivalent.
 */
export function equivalentCall(a: Call, b: Call): boolean {
  if (sameCall(a, b)) return true;
  if (a.tool !== "Bash" || b.tool !== "Bash") return false;
  const ka = commandKey(commandOf(a));
  return ka !== "" && ka === commandKey(commandOf(b));
}

/**
 * The shell command of a Bash call, or `""` when its input has none as text.
 *
 * @param c - A Bash call.
 * @returns The command text.
 */
const commandOf = (c: Call): string => (typeof c.input.command === "string" ? c.input.command : "");

/**
 * Jev's action would have replaced Claude's whole step: one call, equivalent.
 *
 * @param claude - Claude's calls in the step.
 * @param jev - Jev's action.
 * @returns Whether Jev's action covers the step.
 */
export function coversStep(claude: readonly Call[], jev: Call): boolean {
  return claude.length === 1 && equivalentCall(claude[0], jev);
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
 * Lowercase content words, light-stemmed so changes/changed/change match.
 *
 * @param text - Any text.
 * @returns The content words.
 */
export function words(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().split(/[^a-z0-9]+/)) {
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
    for (const w of want) score += name.has(w) ? 2 : desc.has(w) ? 1 : 0;
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
 *
 * @typeParam T - A named item.
 * @param skills - The listed skills.
 * @returns The skills without duplicates.
 */
export function dedupeSkills<T extends { name: string }>(skills: readonly T[]): T[] {
  const base = (n: string) => n.slice(n.lastIndexOf(":") + 1);
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
export const clipScript = (s: string): string => (s.length > 80 ? `${s.slice(0, 80)}…` : s);
