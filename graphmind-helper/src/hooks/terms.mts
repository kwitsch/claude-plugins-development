/**
 * Pure helpers of the graphmind-helper module: prompt term extraction, the search nudge rule, tool-name resolution
 * and the output budget. Ports of the logic in the scripts `graphmind setup` installs (`graphmind-prompt.sh`,
 * `graphmind-search.sh`). Nothing here touches `$`.
 *
 * @packageDocumentation
 */

/** Where the hook output limit of Claude Code cuts a message, in characters (the setup scripts use the same). */
const MAX_CHARS = 9000;

/** The scripts `graphmind setup` installs; their names in `~/.claude/settings.json` mean the user already wired the hooks. */
export const SETUP_SCRIPTS = ["graphmind-session.sh", "graphmind-prompt.sh", "graphmind-search.sh"];

/** The nudge sent once per session when a code search could go through graphmind. */
export const NUDGE = "⚡ This project is graphmind-indexed. Use /gm <query> for code exploration (symbols, callers, deps, outlines). Grep only for string literals/config values.";

/** Words that make poor search terms. */
const STOPWORDS = new Set(
  ("comment how where what who why which show montre explique explain trace parcour fonctionne marche does is me moi la le les the this that these those a an de du des un une et ou en au pour avec sur dans qui que ce ca il elle nous vous ils sont est ont fait faire peut doit from to in of and or but not for with on at by all each can will would should could may might just also very too here there now then be been have has had do it its i you we they je tu ne pas plus aussi bien tout rien encore deja toujours jamais trop peu maintenant ici oui non ok go fais veux peux dois bump version commit push test build run check fix add remove update change make create delete set get put u ur pls please need want like use using see know think sure yes any some into about after before again still done let lets did was were are am our your my their them him her his she he one two other more most much many out up down off over only same than if else so because thing things way good better best new old").split(" "),
);

/** Prompts nobody typed: task results, messages from other sessions, command expansions. */
const NOT_TYPED = ["<task-notification", "<cross-session-message", "<command-", "<local-command", "<system-reminder"];

/** A prompt about code (explore or implement): worth a code pre-fetch. */
const CODE_PROMPT = /comment (fonctionne|marche)|how does|where is|où est|show me|montre|architecture|structure|schema|diagram|explique|explain|what does|qui appelle|who calls|trace|flow|parcour|find|cherche|search|look|refactor|implement|ajoute|add.*to|modify|change.*in|fix.*in|debug|implémente|créer|create/i;

/** A search command starts a command line segment: at a line start (multiline, as grep reads the setup script's pattern), or after `&&`, `||` or `;` (not after a pipe, which filters output). */
const SEG = String.raw`(^|&&|\|\||;)\s*(rtk\s+)?`;

/** A command that is graphmind itself. */
const GRAPHMIND_CMD = new RegExp(`${SEG}graphmind\\b`, "m");

/** A command that is a text or file search. */
const SEARCH_CMD = new RegExp(`${SEG}(grep|egrep|rg|ag|ugrep|find|fd|bfs)\\b`, "m");

/**
 * Whether a prompt is worth a recall: typed by a person and at least 10 characters.
 *
 * @param prompt - The prompt text.
 * @returns True when recall may run.
 */
export function isRecallable(prompt: string): boolean {
  return prompt.length >= 10 && !NOT_TYPED.some((p) => prompt.startsWith(p));
}

/**
 * Whether a prompt is about code, so a symbol search is worth it.
 *
 * @param prompt - The prompt text.
 * @returns True for exploration and implementation prompts.
 */
export function isCodePrompt(prompt: string): boolean {
  return CODE_PROMPT.test(prompt);
}

/**
 * Up to five search terms: identifiers first (camelCase, snake_case, dotted), then other words.
 *
 * @param prompt - The user's prompt.
 * @returns The terms joined by a space.
 */
export function searchTerms(prompt: string): string {
  // Dotted first: JS alternation is leftmost-first, the setup script's grep -oE leftmost-longest.
  const idents = (prompt.match(/[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)+|[A-Za-z0-9]+(?:_[A-Za-z0-9]+)+|[A-Za-z][A-Za-z0-9]*[a-z0-9][A-Z][A-Za-z0-9]*/g) ?? []).map((w) => w.toLowerCase());
  const words = prompt.toLowerCase().replace(/[^a-z0-9_]+/g, " ").split(" ").filter((w) => /^[a-z_][a-z0-9_]{2,}$/.test(w) && !STOPWORDS.has(w));
  return [...new Set([...idents, ...words])].slice(0, 5).join(" ");
}

/** A tool call as the nudge rule reads it: the tool name and the input fields the engine puts on the event. */
export type SearchCall = { tool: string } & Record<string, unknown>;

/**
 * A field as text.
 *
 * @param v - Any value.
 * @returns The value when it is a string, else `""`.
 */
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * Whether this tool call looks like a code search graphmind should answer (and not an exhaustive one, where grep is better).
 *
 * @param call - The tool call.
 * @returns True to nudge.
 */
export function shouldNudge(call: SearchCall): boolean {
  const command = str(call.command);
  const check = `${command} ${str(call.description)}`;
  let search = false;
  if (call.tool === "Grep" || call.tool === "Glob") search = true;
  else if (call.tool === "Bash") search = !GRAPHMIND_CMD.test(command) && SEARCH_CMD.test(command);
  else if (call.tool === "Agent") search = call.subagent_type === "Explore" || /search|find|explore|locate|where is|which file/i.test(str(call.prompt));
  if (!search) return false;
  if (/all (usages|occurrences|references|instances)|find all|list all|exhaustive/i.test(check)) return false;
  return !/\s-[a-zA-Z]*c|\|\s*wc\s|\|\s*sort\s|\|\s*uniq\s/.test(check);
}

/**
 * The entry id a listing line starts with (after an optional star).
 *
 * @param line - A `graphmind memory list` line.
 * @returns The 8-character id, `undefined` when the line has none.
 */
export function entryId(line: string): string | undefined {
  return /[0-9a-f]{8}/.exec(line)?.[0];
}

/**
 * Keeps the non-empty lines that are not graphmind's `>>` header.
 *
 * @param out - Command or tool output.
 * @returns The lines.
 */
export function listing(out: string): string[] {
  return out.split("\n").filter((l) => l.trim() !== "" && !l.startsWith(">>"));
}

/** One block of a message: lines under an optional title (an empty title puts the lines in as plain text). */
export type Block = {
  /** The heading line, `""` for none. */
  title: string;
  /** The lines under it. */
  lines: string[];
};

/** A message built within the budget. */
export type Fitted = {
  /** The message text. */
  text: string;
  /** The lines that made it in whole, from every block. */
  whole: Set<string>;
};

/**
 * Puts blocks into a message of at most `max` characters: a block that fits goes in whole, one that does not is cut
 * (when more than 300 characters are left) and marked, later blocks that do not fit are dropped. The lines of a cut
 * block that were shown before the cut count as whole.
 *
 * @param head - Text the message starts with.
 * @param blocks - The blocks in priority order; empty ones are skipped.
 * @param max - The character budget.
 * @returns The text and the lines that went in whole.
 */
export function fit(head: string, blocks: Block[], max: number = MAX_CHARS): Fitted {
  let text = head;
  const whole = new Set<string>();
  for (const b of blocks) {
    const body = b.lines.join("\n").trimEnd();
    if (!body) continue;
    const block = b.title ? `${b.title}\n${body}\n\n` : `${body}\n\n`;
    const room = max - text.length;
    if (block.length <= room) {
      text += block;
      for (const l of b.lines) whole.add(l);
    } else if (room > 300) {
      // drop a high surrogate the cut split from its pair (emoji): a lone one breaks the JSON the API gets
      const kept = block.slice(0, room - 60).replace(/[\uD800-\uDBFF]$/, "");
      // a line made it in whole when it ends inside the cut, even if its newline was cut off
      let end = b.title ? b.title.length + 1 : 0;
      for (const l of b.lines) {
        end += l.length;
        if (end <= kept.length) whole.add(l);
        end += 1;
      }
      text += `${kept}\n[graphmind: cut to fit the hook output limit]\n`;
    }
  }
  return { text, whole };
}

/** The graphmind MCP tools the module uses. */
export type GmTools = {
  /** `gm_status`. */
  status: string;
  /** `gm_map`. */
  map: string;
  /** `gm_memory_list`. */
  memoryList: string;
  /** `gm_search`. */
  search: string;
};

/**
 * Finds the graphmind MCP tools in the engine's tool list. The plugin's own server and the one `graphmind setup`
 * registers carry different names (`mcp__plugin_graphmind-helper_graphmind__gm_status` and `mcp__graphmind__gm_status`),
 * so the tools are matched by their `__gm_*` suffix on a server whose name holds `graphmind`; the plugin's own server wins.
 *
 * @param tools - The engine's tool list.
 * @returns The tool names, `undefined` when `gm_status` or another needed tool is missing.
 */
export function resolveTools(tools: readonly { name: string }[]): GmTools | undefined {
  const find = (suffix: string): string | undefined => {
    const hits = tools.map((t) => t.name).filter((n) => /^mcp__.*graphmind.*__gm_/.test(n) && n.endsWith(`__gm_${suffix}`));
    return hits.find((n) => n.includes("plugin_graphmind-helper")) ?? hits[0];
  };
  const status = find("status");
  const map = find("map");
  const memoryList = find("memory_list");
  const search = find("search");
  return status && map && memoryList && search ? { status, map, memoryList, search } : undefined;
}

/**
 * The directories to look for the graphmind binary in, as the setup scripts do: absolute PATH entries, then
 * `~/.graphmind/bin`, `~/.local/bin` and `/usr/local/bin`. Shared by the module and the MCP wrapper.
 *
 * @param pathVar - The PATH value.
 * @param home - The home directory, `undefined` when unknown.
 * @param delimiter - The PATH delimiter.
 * @returns The directories without a trailing slash.
 */
export function binaryDirs(pathVar: string | undefined, home: string | undefined, delimiter = ":"): string[] {
  const dirs = (pathVar ?? "").split(delimiter).filter((d) => d.startsWith("/"));
  if (home) dirs.push(`${home}/.graphmind/bin`, `${home}/.local/bin`);
  dirs.push("/usr/local/bin");
  return dirs.map((d) => d.replace(/(.)\/+$/, "$1")); // keep "/" itself: "" would make the binary path relative
}
