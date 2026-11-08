/**
 * Questions and the rules that turn Jev's answers into actions. Pure, so tests can check every threshold without
 * the engine or the network.
 *
 * @packageDocumentation
 */
import type { Candidate } from "./candidates.mjs";
import type { ChoiceAnswer, Question, ScoreAnswer } from "./jev.mjs";

/** The option that leaves the step to Claude. */
export const CLAUDE = "claude";

/**
 * The next-action choice question over the listed candidates plus `claude`.
 *
 * @param candidates - The actions Jev may take.
 * @returns The question.
 */
export function nextActionQuestion(candidates: readonly Candidate[]): Question {
  const criteria: Record<string, string | null> = {
    [CLAUDE]: "Something not listed: writing or editing code, composing a different command, answering or explaining to the user, planning, or any step that needs judgment.",
  };
  for (const c of candidates) criteria[c.key] = c.description;
  return {
    type: "choice",
    instructions: [
      "An AI coding assistant is working on the user request in `request`; `recent` lists its latest steps and their results.",
      "Pick the assistant's single best next action.",
      "Pick a listed action (read, run, skill, load) only when that exact action is clearly the right next step now. Pick a skill only when the request is squarely what that skill is for, and load a tool only when the request needs that tool. If the needed information is already in `recent`, or the assistant should now write code or reply, pick claude.",
    ],
    criteria,
  };
}

/** Whether one read-only action plus a short report fully answers the request (whole-turn bypass). */
export const singleActionQuestion: Question = {
  type: "noul",
  instructions: "Can the user request in `request` be fully answered by performing one read-only action (reading one file, or running one routine command such as the tests or git status) and briefly reporting what it shows?",
  criteria: {
    true: "Yes: the request only asks to run, read, show or check something, and a short report of that one result fully answers it",
    false: "No: it also needs code changes, several steps, investigation, explanation beyond the output, or judgment",
  },
};

/** The difficulty levels, index 0–3. */
export const DIFFICULTY_LEVELS = [
  "Trivial: a lookup, running a known command, or a short factual answer",
  "Routine: a small, well-specified change or explanation in one place",
  "Substantial: changes across several files, debugging with an unclear cause, or design choices",
  "Hard: architecture, subtle concurrency or security issues, or a large ambiguous task",
];

/** How much reasoning the request needs. */
export const difficultyQuestion: Question = {
  type: "score",
  instructions: "How much reasoning does an AI coding assistant need to fully handle the user request in `request`? When `previous_reply` is present, `request` answers the assistant's previous reply: judge a short follow-up like 'yes' or 'do it' by the work it approves or asks about there.",
  criteria: DIFFICULTY_LEVELS,
};

/** Whether the assistant finished the request when it stopped. */
export const doneQuestion: Question = {
  type: "noul",
  instructions: "An AI coding assistant just stopped. Did it fully finish the user's request in `request`, judging from `final_message` and `recent`?",
  criteria: {
    true: "Finished, or stopped for a good reason: it needs an answer only the user can give, or it reports a real blocker",
    false: "Stopped partway: steps it said it would do are not done, it asks permission to continue work it could just do, or the request is only partly handled",
  },
};

/**
 * The most likely option other than claude, with its probability.
 *
 * @param answer - The next-action answer.
 * @returns The best listed action, or `undefined` without an answer or options.
 */
export function bestAction(answer: ChoiceAnswer | undefined): { key: string; p: number } | undefined {
  if (!answer) return undefined;
  let best: { key: string; p: number } | undefined;
  for (const [key, p] of Object.entries(answer.probabilities)) {
    if (key !== CLAUDE && (!best || p > best.p)) best = { key, p };
  }
  return best;
}

/**
 * Which candidate Jev takes, or undefined to let Claude decide.
 *
 * @param answer - The next-action answer.
 * @param candidates - The offered candidates.
 * @param threshold - The minimum probability of the pick.
 * @returns The candidate to take, or `undefined`.
 */
export function pickCandidate(answer: ChoiceAnswer | undefined, candidates: readonly Candidate[], threshold: number): Candidate | undefined {
  if (!answer || answer.choice === CLAUDE) return undefined;
  if ((answer.probabilities[answer.choice] ?? 0) < threshold) return undefined;
  return candidates.find((c) => c.key === answer.choice);
}

/** A thinking-effort level. */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
/** The effort levels, lowest first. */
const EFFORT_ORDER: Effort[] = ["low", "medium", "high", "xhigh", "max"];

/** A turn's routing: the difficulty score and the effort or model to use. */
export type Route = { level: number; effort?: Effort; model?: string };

/**
 * Cut points on Jev's 0–3 difficulty score. Tuned on effortless's 75 hand-labelled prompts: 57% of picks
 * acceptable with low < 0.75 and lowering only, 91% with these cuts and raising big jobs to high.
 */
export const LOW_BELOW = 1.0;
/** Scores from here on are big jobs. */
export const HIGH_FROM = 1.8;

/**
 * Trivial → low (Haiku in model mode), routine → medium (Sonnet), big → high.
 *
 * @param answer - The difficulty answer.
 * @param mode - Whether to also pick a cheaper model.
 * @returns The route, or `undefined` without a confident answer.
 */
export function route(answer: ScoreAnswer | undefined, mode: "effort" | "model"): Route | undefined {
  if (!answer || answer.confidence < 0.5) return undefined;
  const level = answer.score;
  if (level < LOW_BELOW) return { level, effort: "low", ...(mode === "model" ? { model: "claude-haiku-5-5" } : {}) };
  if (level < HIGH_FROM) return { level, effort: "medium", ...(mode === "model" ? { model: "claude-sonnet-5-5" } : {}) };
  return { level, effort: "high" };
}

/**
 * Models where a change of effort keeps the prompt cache (Opus and Sonnet 5.5). On others it rewrites the cache,
 * which costs more than lower effort saves.
 *
 * @param model - The model id.
 * @returns Whether effort may be changed.
 */
export const effortKeepsCache = (model: string): boolean => /(opus|sonnet)-5-5/.test(model);

/**
 * The effort to send instead of `current`, or nothing: low and medium only lower it; high only raises it, from low
 * or medium, so a big job never runs below high and a person's xhigh or max is never lowered on a big job.
 *
 * @param current - The step's effort.
 * @param target - The route's effort.
 * @returns The effort to send, or `undefined` to leave it.
 */
export function adjustEffort(current: unknown, target: Effort | undefined): Effort | undefined {
  if (!target || typeof current !== "string") return undefined;
  const ci = EFFORT_ORDER.indexOf(current as Effort);
  const ti = EFFORT_ORDER.indexOf(target);
  if (ci < 0) return undefined;
  if (target === "high") return ci < ti ? target : undefined;
  return ci > ti ? target : undefined;
}

/**
 * The price tier of a model id: 0 Haiku, 1 Sonnet, 2 Opus/Fable, -1 unknown.
 *
 * @param model - The model id.
 * @returns The tier.
 */
const MODEL_TIER = (model: string): number => (/haiku/.test(model) ? 0 : /sonnet/.test(model) ? 1 : /opus|fable/.test(model) ? 2 : -1);

/**
 * The target model only when it is a cheaper tier than the current one.
 *
 * @param current - The step's model.
 * @param target - The route's model.
 * @returns The model to send, or `undefined` to leave it.
 */
export function lowerModel(current: string, target: string | undefined): string | undefined {
  if (!target) return undefined;
  const c = MODEL_TIER(current);
  return c > MODEL_TIER(target) ? target : undefined;
}

/**
 * Whether the done check sends Claude back.
 *
 * @param done - The finished probability.
 * @param threshold - Below this the work is unfinished.
 * @returns Whether to continue.
 */
export function shouldContinue(done: number | undefined, threshold = 0.15): boolean {
  return done !== undefined && done < threshold;
}

/**
 * Whether a file lies inside this session's scratchpad directory, `<root>/claude-<digits>/<project slug>/<session id>/scratchpad/<at least one segment>`.
 * The project slug is not checked: it comes from the session-start directory, which differs from the cwd in a worktree.
 *
 * @param file - The absolute path of the file.
 * @param sessionId - The session id.
 * @param roots - The candidate temp roots (`CLAUDE_CODE_TMPDIR`, `TMPDIR`, `/tmp`).
 * @returns Whether the path is a file below the session's scratchpad; any `..` segment rejects it.
 */
export function inScratchpad(file: string, sessionId: string, roots: readonly string[]): boolean {
  if (!file.startsWith("/") || !sessionId) return false;
  const segs = file.split("/");
  if (segs.includes("..")) return false;
  const path = `/${segs.filter((seg) => seg !== "" && seg !== ".").join("/")}`;
  // shortcut: lexical containment only. A symlink inside the scratchpad, or a pre-made `claude-<digits>` dir under a shared /tmp, can point elsewhere; upgrade when $.fs offers realpath/lstat.
  for (const root of roots) {
    const prefix = `${root.replace(/\/+$/, "")}/`;
    if (prefix === "/" || !path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length).split("/");
    if (rest.length >= 5 && /^claude-\d+$/.test(rest[0]) && rest[2] === sessionId && rest[3] === "scratchpad") return true;
  }
  return false;
}
