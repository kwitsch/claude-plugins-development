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
  const criteria: Record<string, string> = {
    [CLAUDE]: "Something not listed: writing or editing code, composing a different command, answering or explaining to the user, planning, or any step that needs judgment.",
  };
  for (const c of candidates) criteria[c.key] = c.description;
  return {
    type: "choice",
    instructions: [
      "An AI coding assistant is working on the user request in `request`; `recent` lists its latest steps and their results.",
      "Pick the assistant's single best next action.",
      "Pick a listed action (read, run, skill, load) only when that exact action is clearly the right next step now. Pick a skill only when the request is squarely what that skill is for, and load a tool only when the request needs that tool. If the needed information is already in `recent`, or the assistant should now write code or reply, pick claude.",
    ].join(" "),
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
export const EFFORT_ORDER: Effort[] = ["low", "medium", "high", "xhigh", "max"];

/**
 * Whether a value is one of the effort levels.
 *
 * @param v - The value.
 * @returns Whether it is an {@link Effort}.
 */
export function isEffort(v: unknown): v is Effort {
  return (EFFORT_ORDER as readonly unknown[]).includes(v);
}

/** The model families the estimate knows, cheapest first. */
export type EstimateModel = "haiku" | "sonnet" | "opus" | "fable";
/** The model families, cheapest first. */
export const ESTIMATE_MODELS: readonly EstimateModel[] = ["haiku", "sonnet", "opus", "fable"];
/** Effort levels added to Jev's score per model: a stronger model needs less. */
const MODEL_BIAS: Record<EstimateModel, number> = { haiku: 0.75, sonnet: 0.25, opus: -0.25, fable: -0.75 };
/**
 * Session models whose effort is estimated on every turn. On the others the effort is estimated on the loop's first
 * turn only and then held, so a later change of effort does not rewrite the prompt cache.
 */
export const EVERY_TURN_MODELS: readonly EstimateModel[] = ["sonnet", "opus"];
/** Below this confidence a Jev score is not used. */
export const MIN_CONFIDENCE = 0.5;
/** From this probability on, a prompt counts as purely mechanical. */
export const MECHANICAL_FROM = 0.8;
/** The tool's registered name; the model sees it as {@link ESTIMATE_TOOL}. */
export const ESTIMATE_NAME = "estimate_effort";
/** The name calls to the tool arrive under at `tool.call`. */
export const ESTIMATE_TOOL = `mcp__jevfort__${ESTIMATE_NAME}`;

/** What the estimate needs besides the prompt. */
export type EstimateBounds = {
  /** The model family that will run the prompt; picks the bias. */
  model: EstimateModel;
  /** Returned unchanged when Jev is unreachable or unsure. */
  defaultEffort: Effort;
  /** Lowest effort Jev's estimate may give; the answer for a mechanical prompt. */
  minEffort: Effort;
  /** Highest effort Jev's estimate may give. */
  maxEffort: Effort;
};
/** A validated tool call. */
export type EstimateInput = EstimateBounds & {
  /** The prompt to estimate. */
  prompt: string;
};
/** The estimate and why: Jev's score, the mechanical shortcut, or the fallback to the default. */
export type Estimate = {
  /** The effort to use. */
  effort: Effort;
  /** Where it came from. */
  source: "jev" | "mechanical" | "fallback";
};

/**
 * Whether a value is exactly one of the model family names (no model id).
 *
 * @param v - The value.
 * @returns Whether it is an {@link EstimateModel}.
 */
const isModel = (v: unknown): v is EstimateModel => (ESTIMATE_MODELS as readonly unknown[]).includes(v);

/**
 * The model family of a model id or bare family name: haiku, sonnet, opus, fable tested in that order, first match wins.
 *
 * @param id - A model id such as `claude-opus-5-5`, or a bare family name.
 * @returns The family, or `undefined` when none matches.
 */
export function modelFamily(id: string): EstimateModel | undefined {
  return ESTIMATE_MODELS.find((m) => id.includes(m));
}

/**
 * Whether an effort level lies within the bounds (both ends included).
 *
 * @param level - The effort level.
 * @param range - The bounds.
 * @returns `true` when the level ranks neither below the minimum nor above the maximum.
 */
export function inBandRange(level: Effort, range: { minEffort: Effort; maxEffort: Effort }): boolean {
  const i = EFFORT_ORDER.indexOf(level);
  return i >= EFFORT_ORDER.indexOf(range.minEffort) && i <= EFFORT_ORDER.indexOf(range.maxEffort);
}

/**
 * The effort bounds, when both are effort levels and the minimum does not rank above the maximum.
 *
 * @param min - The lowest effort.
 * @param max - The highest effort.
 * @returns The bounds, or `undefined` when either is no effort level or they are inverted.
 */
export function bounds(min: unknown, max: unknown): { minEffort: Effort; maxEffort: Effort } | undefined {
  if (!isEffort(min) || !isEffort(max) || EFFORT_ORDER.indexOf(min) > EFFORT_ORDER.indexOf(max)) return undefined;
  return { minEffort: min, maxEffort: max };
}

/**
 * Validates an `estimate_effort` call (trust boundary). A `defaultEffort` outside the bounds is valid.
 *
 * @param raw - The `tool.call` event with the tool's input fields on it.
 * @returns The five input fields (extra event fields dropped), or the first error as text.
 */
export function parseEstimateInput(raw: Record<string, unknown>): EstimateInput | string {
  const { model, defaultEffort, minEffort, maxEffort, prompt } = raw;
  const effortError = (name: string): string => `${name} must be one of ${EFFORT_ORDER.join(", ")}`;
  if (!isModel(model)) return `model must be one of ${ESTIMATE_MODELS.join(", ")}`;
  if (!isEffort(defaultEffort)) return effortError("defaultEffort");
  if (!isEffort(minEffort)) return effortError("minEffort");
  if (!isEffort(maxEffort)) return effortError("maxEffort");
  if (!bounds(minEffort, maxEffort)) return "minEffort must not be above maxEffort";
  if (typeof prompt !== "string" || prompt.trim() === "") return "prompt must be a non-empty string";
  return { model, defaultEffort, minEffort, maxEffort, prompt };
}

/**
 * The single effort rule of the tool and of turn-start routing, in this order: a mechanical prompt (Jev p ≥
 * {@link MECHANICAL_FROM}) gets `minEffort`; without a confident score (missing, malformed, or confidence below
 * {@link MIN_CONFIDENCE}) `defaultEffort` is returned unclamped; otherwise Jev's 0–4 score plus the model's bias,
 * rounded and clamped to `minEffort`..`maxEffort`.
 *
 * @param effort - Jev's effort score answer, `undefined` when missing or Jev was unreachable.
 * @param mechanical - Jev's probability that the prompt is purely mechanical, `undefined` when missing.
 * @param b - The model, the default and the bounds; the bounds must be valid ({@link bounds}).
 * @returns The effort and its source.
 */
export function estimateEffort(effort: ScoreAnswer | undefined, mechanical: number | undefined, b: EstimateBounds): Estimate {
  if (mechanical !== undefined && mechanical >= MECHANICAL_FROM) return { effort: b.minEffort, source: "mechanical" };
  if (!effort || !Number.isFinite(effort.score) || !(effort.confidence >= MIN_CONFIDENCE)) return { effort: b.defaultEffort, source: "fallback" };
  const i = Math.round(effort.score + MODEL_BIAS[b.model]);
  const clamped = Math.min(Math.max(i, EFFORT_ORDER.indexOf(b.minEffort)), EFFORT_ORDER.indexOf(b.maxEffort));
  return { effort: EFFORT_ORDER[clamped], source: "jev" };
}

/** The effort levels as Jev's score criteria, index 0 low … 4 max. */
export const EFFORT_LEVELS = [
  "Low: a lookup, running a known command, or a short factual answer",
  "Medium: a small, well-specified change or explanation in one place",
  "High: changes across several files, debugging with an unclear cause, or design choices",
  "Extra high: architecture, subtle concurrency or security issues, or a large ambiguous task",
  "Max: a long multi-part task needing deep, novel reasoning where mistakes are costly",
];

/** How much reasoning effort a mid-tier model needs for the request; "mid-tier" is the zero point of the model bias. */
export const effortQuestion: Question = {
  type: "score",
  instructions: "How much reasoning effort does a mid-tier AI coding model need to fully handle the user request in `request`? When `previous_reply` is present, `request` answers the assistant's previous reply: judge a short follow-up like 'yes' or 'do it' by the work it approves or asks about there.",
  criteria: EFFORT_LEVELS,
};

/** Whether the request is a purely mechanical task. */
export const mechanicalQuestion: Question = {
  type: "noul",
  instructions: "Is the user request in `request` a purely mechanical task that needs no judgment, design or investigation?",
  criteria: {
    true: "Yes: renaming, reformatting, moving or copying, running a named command, or applying an edit spelled out exactly",
    false: "No: it needs understanding, choices, debugging, explanation or design",
  },
};

/** The `estimate_effort` tool spec `session.start` registers through `$.tool.register`. */
export const ESTIMATE_SPEC = {
  name: ESTIMATE_NAME,
  description: "Estimate the reasoning effort a prompt most likely needs, decided by TypeSafe Jev. Returns JSON {\"effort\": level, \"source\": \"jev\"|\"mechanical\"|\"fallback\"}: a purely mechanical prompt gets minEffort; Jev's estimate is biased by the model (a stronger model needs less) and kept within minEffort..maxEffort; when Jev is unreachable or unsure, defaultEffort.",
  inputSchema: {
    type: "object",
    properties: {
      model: { type: "string", enum: [...ESTIMATE_MODELS], description: "The model that will run the prompt" },
      defaultEffort: { type: "string", enum: [...EFFORT_ORDER], description: "Returned when Jev is unreachable or unsure" },
      minEffort: { type: "string", enum: [...EFFORT_ORDER], description: "Lowest effort to return; also the answer for a mechanical prompt" },
      maxEffort: { type: "string", enum: [...EFFORT_ORDER], description: "Highest effort to return" },
      prompt: { type: "string", description: "The prompt to estimate" },
    },
    required: ["model", "defaultEffort", "minEffort", "maxEffort", "prompt"],
  },
};

/** A turn's routing: the difficulty score and, in model mode, the model to use. */
export type Route = { level: number; model?: string };

/**
 * Cut points on Jev's 0–3 difficulty score. Tuned on effortless's 75 hand-labelled prompts: 57% of picks
 * acceptable with low < 0.75 and lowering only, 91% with these cuts and raising big jobs to high.
 */
export const LOW_BELOW = 1.0;
/** Scores from here on are big jobs. */
export const HIGH_FROM = 1.8;

/**
 * The difficulty route: in model mode trivial → Haiku and routine → Sonnet, big jobs keep the model; effort mode only
 * carries the score. The turn's effort comes from {@link estimateEffort}.
 *
 * @param answer - The difficulty answer.
 * @param mode - Whether to also pick a cheaper model.
 * @returns The route, or `undefined` below {@link MIN_CONFIDENCE}.
 */
export function route(answer: ScoreAnswer | undefined, mode: "effort" | "model"): Route | undefined {
  if (!answer || answer.confidence < MIN_CONFIDENCE) return undefined;
  const level = answer.score;
  if (mode === "effort" || level >= HIGH_FROM) return { level };
  return { level, model: level < LOW_BELOW ? "claude-haiku-5-5" : "claude-sonnet-5-5" };
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
