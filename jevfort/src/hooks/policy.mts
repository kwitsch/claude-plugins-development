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

/** Whether the turn that just ended closed a task (a good moment to compact) or only reached an intermediate result. */
export const taskEndQuestion: Question = {
  type: "noul",
  instructions: "An AI coding assistant just ended a turn. Did it close a whole task for the user (the request in `request` is done and nothing it announced remains), judging from `final_message` and `recent`?",
  criteria: {
    true: "A task is complete: the result is delivered and the next message would start something new",
    false: "An intermediate result: work continues, a step is reported, a question awaits the user's answer or more steps of the same task are expected",
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
/**
 * Session models whose effort is estimated on every turn. On the others the effort is estimated on the loop's first
 * turn only and then held, so a later change of effort does not rewrite the prompt cache.
 */
export const EVERY_TURN_MODELS: readonly EstimateModel[] = ["sonnet", "opus"];
/** From this probability on, a prompt counts as purely mechanical (measured 2026-11-13: 0.8 sent 16 of 24 medium prompts to minEffort). */
export const MECHANICAL_FROM = 0.95;
/** Score cut points between low|medium|high|xhigh|max, measured on 120 labelled prompts (2026-11-13, d1-3b). The last one is provisional. */
export const EFFORT_CUTS = [1.05, 1.9, 2.5, 3.1] as const;
/** The score ends of the {@link effortLevel} segments: 0, the cut points, 4. */
const CUT_X: readonly number[] = [0, ...EFFORT_CUTS, 4];
/** The level-scale ends of the segments: 0, then each cut on the middle of a level (0.5, 1.5, ...), then 4. */
const CUT_Y: readonly number[] = [0, ...EFFORT_CUTS.map((_, i) => i + 0.5), 4];

/**
 * Maps Jev's 0–4 effort score onto the level scale piecewise linearly, so that `Math.round` of the result gives the
 * calibrated level: the {@link EFFORT_CUTS} land on 0.5 / 1.5 / 2.5 / 3.5. There is no model bias: the level is the same for every model.
 *
 * @param score - Jev's effort score; clamped to 0..4.
 * @returns The position on the level scale, 0..4.
 */
export function effortLevel(score: number): number {
  const s = Math.min(Math.max(score, 0), 4);
  // The segment's upper end; s <= 4 always finds one, and a score of 0 uses the first segment.
  const i = Math.max(1, CUT_X.findIndex((x) => s <= x));
  return CUT_Y[i - 1] + ((s - CUT_X[i - 1]) / (CUT_X[i] - CUT_X[i - 1])) * (CUT_Y[i] - CUT_Y[i - 1]);
}
/** The tool's registered name; the model sees it as {@link ESTIMATE_TOOL}. */
export const ESTIMATE_NAME = "estimate_effort";
/** The name calls to the tool arrive under at `tool.call`. */
export const ESTIMATE_TOOL = `mcp__jevfort__${ESTIMATE_NAME}`;

/** What the estimate needs besides the prompt. */
export type EstimateBounds = {
  /** The model family that will run the prompt; it does not change the estimate (the model bias was removed in 0.9.0), the tool keeps it for callers. */
  model: EstimateModel;
  /** Returned unchanged when Jev is unreachable or gives no effort score. */
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
 * {@link MECHANICAL_FROM}) gets `minEffort`; without a finite score (missing or malformed) `defaultEffort` is
 * returned unclamped (the score's confidence is not checked: the discarded scores were as accurate as the kept ones);
 * otherwise Jev's 0–4 score mapped by {@link effortLevel}, rounded and clamped to
 * `minEffort`..`maxEffort`.
 *
 * @param effort - Jev's effort score answer, `undefined` when missing or Jev was unreachable.
 * @param mechanical - Jev's probability that the prompt is purely mechanical, `undefined` when missing.
 * @param b - The default and the bounds (the model is not used); the bounds must be valid ({@link bounds}).
 * @returns The effort and its source.
 */
export function estimateEffort(effort: ScoreAnswer | undefined, mechanical: number | undefined, b: EstimateBounds): Estimate {
  if (mechanical !== undefined && mechanical >= MECHANICAL_FROM) return { effort: b.minEffort, source: "mechanical" };
  if (!effort || !Number.isFinite(effort.score)) return { effort: b.defaultEffort, source: "fallback" };
  const i = Math.round(effortLevel(effort.score));
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

/** How much reasoning effort a mid-tier model needs for the request. */
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
  description: "Estimate the reasoning effort a prompt most likely needs, decided by TypeSafe Jev. Returns JSON {\"effort\": level, \"source\": \"jev\"|\"mechanical\"|\"fallback\"}: a purely mechanical prompt gets minEffort; Jev's estimate (the same for every model) is kept within minEffort..maxEffort; when Jev is unreachable or gives no effort score, defaultEffort.",
  inputSchema: {
    type: "object",
    properties: {
      model: { type: "string", enum: [...ESTIMATE_MODELS], description: "The model that will run the prompt" },
      defaultEffort: { type: "string", enum: [...EFFORT_ORDER], description: "Returned when Jev is unreachable or gives no effort score" },
      minEffort: { type: "string", enum: [...EFFORT_ORDER], description: "Lowest effort to return; also the answer for a mechanical prompt" },
      maxEffort: { type: "string", enum: [...EFFORT_ORDER], description: "Highest effort to return" },
      prompt: { type: "string", description: "The prompt to estimate" },
    },
    required: ["model", "defaultEffort", "minEffort", "maxEffort", "prompt"],
  },
};

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
  // A backslash is a separator and a leading `//` a network path to Win32: both could leave the scratchpad after the lexical check.
  if (!file.startsWith("/") || file.startsWith("//") || file.includes("\\") || !sessionId) return false;
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
