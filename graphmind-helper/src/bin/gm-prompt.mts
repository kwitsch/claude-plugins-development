#!/usr/bin/env node
// UserPromptSubmit hook: the memory and code recall of `graphmind setup`'s graphmind-prompt.sh, plus the memory checkpoint every 10th prompt.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { emit, entryId, findGraphmind, listing, MAX_CHARS, readInput, registered, run, setupHooksPresent, stateDir, str, wholeIds } from "./common.mjs";

/** Words that make poor search terms. */
const STOPWORDS = new Set(
  ("comment how where what who why which show montre explique explain trace parcour fonctionne marche does is me moi la le les the this that these those a an de du des un une et ou en au pour avec sur dans qui que ce ca il elle nous vous ils sont est ont fait faire peut doit from to in of and or but not for with on at by all each can will would should could may might just also very too here there now then be been have has had do it its i you we they je tu ne pas plus aussi bien tout rien encore deja toujours jamais trop peu maintenant ici oui non ok go fais veux peux dois bump version commit push test build run check fix add remove update change make create delete set get put u ur pls please need want like use using see know think sure yes any some into about after before again still done let lets did was were are am our your my their them him her his she he one two other more most much many out up down off over only same than if else so because thing things way good better best new old").split(" "),
);

/** Prompts nobody typed: task results, messages from other sessions, command expansions. */
const NOT_TYPED = ["<task-notification", "<cross-session-message", "<command-", "<local-command", "<system-reminder"];

/** A prompt about code (explore or implement): worth a code pre-fetch. */
const CODE_PROMPT = /comment (fonctionne|marche)|how does|where is|où est|show me|montre|architecture|structure|schema|diagram|explique|explain|what does|qui appelle|who calls|trace|flow|parcour|find|cherche|search|look|refactor|implement|ajoute|add.*to|modify|change.*in|fix.*in|debug|implémente|créer|create/i;

/**
 * Up to five search terms: identifiers first (camelCase, snake_case, dotted), then other words.
 *
 * @param prompt - The user's prompt.
 * @returns The terms joined by a space.
 */
export function searchTerms(prompt: string): string {
  const idents = (prompt.match(/[A-Za-z][A-Za-z0-9]*[a-z0-9][A-Z][A-Za-z0-9]*|[A-Za-z0-9]+(?:_[A-Za-z0-9]+)+|[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)+/g) ?? []).map((w) => w.toLowerCase());
  const words = prompt.toLowerCase().replace(/[^a-z0-9_]+/g, " ").split(" ").filter((w) => /^[a-z_][a-z0-9_]{2,}$/.test(w) && !STOPWORDS.has(w));
  return [...new Set([...idents, ...words])].slice(0, 5).join(" ");
}

/** Prints the recall for this prompt. */
function main(): void {
  const bin = findGraphmind();
  if (!bin || setupHooksPresent()) return;
  const input = readInput();
  const prompt = str(input.user_prompt) || str(input.prompt);
  if (NOT_TYPED.some((p) => prompt.startsWith(p)) || prompt.length < 10 || !registered(bin)) return;

  const dir = stateDir(input.session_id);
  mkdirSync(dir, { recursive: true });
  const shownFile = join(dir, "priority-ids");
  const shown = new Set(existsSync(shownFile) ? readFileSync(shownFile, "utf8").split("\n") : []);
  const fresh = (lines: string[]) => lines.filter((l) => !shown.has(entryId(l) ?? ""));

  const turnsFile = join(dir, "turns");
  const turn = (existsSync(turnsFile) ? Number(readFileSync(turnsFile, "utf8")) || 0 : 0) + 1;
  writeFileSync(turnsFile, `${turn}\n`);
  const checkpoint = turn % 10 === 0
    ? `[graphmind checkpoint — prompt ${turn}] Review the last 10 prompts. Call gm_session_analyze with an array of facts (decisions, conventions, bugs, constraints) that emerged — it batch-saves and deduplicates in one call. Use priority=true for facts needed every session.`
    : "";

  const priority = fresh(listing(run(bin, ["memory", "list", "--priority", "--limit", "10", "--max-chars", "300"]).stdout));
  const terms = searchTerms(prompt);
  let memory: string[] = [];
  let code: string[] = [];
  const cacheFile = join(dir, "search-cache.txt");
  if (terms) {
    const now = Math.floor(Date.now() / 1000);
    const cached = existsSync(cacheFile) && readFileSync(cacheFile, "utf8").split("\n").slice(-50).some((l) => {
      const [ts, q] = l.split("|");
      return q === terms && now - Number(ts) < 180;
    });
    if (!cached) {
      // --no-recall: an automatic search on every prompt is not a sign the entry matters.
      memory = fresh(listing(run(bin, ["memory", "search", terms, "--limit", "5", "--max-chars", "300", "--no-recall"]).stdout).filter((l) => !l.startsWith("!"))).slice(0, 5);
      if (CODE_PROMPT.test(prompt)) code = run(bin, ["search", terms, "--limit", "5", "--code-only"]).stdout.split("\n").slice(0, 30);
      appendFileSync(cacheFile, `${now}|${terms}\n`);
    }
  }

  let msg = checkpoint ? `${checkpoint}\n\n` : "";
  const add = (title: string, lines: string[]) => {
    const text = lines.join("\n").trimEnd();
    if (!text) return;
    const block = `${title}\n${text}\n\n`;
    const room = MAX_CHARS - msg.length;
    if (block.length <= room) msg += block;
    else if (room > 300) msg += `${block.slice(0, room - 60)}\n[graphmind: cut to fit the hook output limit]\n`;
  };
  add("[graphmind memory] Relevant:", memory);
  add("[graphmind code] Relevant symbols:", code);
  add("[graphmind ★ new priority context]", priority);

  // Only the priority entries that made it into the message whole count as shown.
  const ids = wholeIds(msg, priority);
  if (ids.length) appendFileSync(shownFile, ids.map((i) => `${i}\n`).join(""));
  if (msg) emit("UserPromptSubmit", msg);
}

// Not run when a test imports `searchTerms`.
if (process.argv[1]?.endsWith("gm-prompt.mjs")) main();
