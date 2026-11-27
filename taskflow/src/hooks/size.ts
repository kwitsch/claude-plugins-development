/**
 * The size question of `build-task`, pure: the calibrated question for System One, how its answer and a plain model
 * answer are read, and how the tool input becomes the state. No engine access here (only `register.ts` touches `$`).
 * Why this wording and threshold: `development/wiki/plugins/taskflow/design/size-calibration.md`.
 *
 * @packageDocumentation
 */

import type { ToolResult } from "./types.js";

/** The sizes, smallest first. */
export const SIZES = ["S", "M", "L", "XL"] as const;

/** One of {@link SIZES}. */
export type Size = (typeof SIZES)[number];

/** The calibrated options of the `choice` question: size to description. Do not reword without re-running the calibration. */
export const OPTIONS: Record<Size, string> = {
  S: "one single edit in one place: a flag, option, label, wording, doc note, config line or tiny fix; no new logic, no new tests",
  M: "a feature, option or fix with new or changed logic and tests, inside one plugin, one concern, a few files",
  L: "a feature, port or refactor with several distinct parts (new module plus callers, tests and docs), a whole plugin, or changes across two to four plugins",
  XL: "repository-wide: build, CI, tooling, shared layer, conventions or architecture, affecting most or all plugins at once",
};

/** The question's instructions. */
export const INSTRUCTIONS = "How large is the work? Pick the smallest option that covers the whole task; when it could be two neighbouring options, pick the larger.";

/** The lowest `probabilities[choice]` of System One's answer that is taken as the size. */
export const MIN_PROBABILITY = 0.5;

/** The longest task text taken (characters); longer input is refused. */
export const MAX_TASK_CHARS = 20_000;

/** The most subsystem lines taken. */
export const MAX_SUBSYSTEMS = 8;

/** The longest subsystem line taken (characters). */
export const MAX_SUBSYSTEM_CHARS = 300;

/** The model of the plain fallback (measured: `development/wiki/plugins/taskflow/design/size-calibration.md`). */
export const FALLBACK_MODEL = "claude-opus-5-5";

/** The question as `mcp__jev-api__request` takes it. */
export const QUESTION = { type: "choice", instructions: INSTRUCTIONS, criteria: OPTIONS } as const;

/**
 * The state of the question: the task text and one line per subsystem.
 *
 * @param task - The task text.
 * @param subsystems - The subsystem lines.
 * @returns The trimmed lines, newline separated.
 */
export function buildState(task: string, subsystems: readonly string[]): string {
  return [task.trim(), ...subsystems.map((s) => s.trim())].join("\n");
}

/**
 * Checks the tool input and builds the state.
 *
 * @param input - The `tool.call` event (task, optional subsystems).
 * @returns The state, or the reason the input is refused.
 */
export function parseInput(input: Record<string, unknown>): string | { error: string } {
  const task = input["task"];
  if (typeof task !== "string" || task.trim() === "") return { error: "task must be a non-blank string" };
  if (task.length > MAX_TASK_CHARS) return { error: `task is longer than ${MAX_TASK_CHARS} characters` };
  const subs = input["subsystems"];
  if (subs !== undefined && (!Array.isArray(subs) || subs.length > MAX_SUBSYSTEMS || subs.some((s) => typeof s !== "string" || s.trim() === ""))) {
    return { error: `subsystems must be at most ${MAX_SUBSYSTEMS} non-blank strings` };
  }
  // A generated focus text may run long: cut it by code point (never inside a surrogate pair), do not refuse the call (a refusal drops the skill to its uncalibrated own reasoning).
  return buildState(task, ((subs as string[] | undefined) ?? []).map((s) => Array.from(s).slice(0, MAX_SUBSYSTEM_CHARS).join("")));
}

/** A System One choice answer read for the size. */
export type Pick = {
  /** The option chosen. */
  size: Size;
  /** `probabilities[choice]`. */
  probability: number;
};

/**
 * Reads the text `mcp__jev-api__request` returns for one `choice` question.
 *
 * @param text - The result text: a JSON array of answers.
 * @returns The choice and its probability, or undefined when the text is not a valid choice answer.
 */
export function readAnswer(text: string): Pick | undefined {
  let list: unknown;
  try {
    list = JSON.parse(text);
  } catch {
    return undefined;
  }
  const a: unknown = Array.isArray(list) ? list[0] : undefined;
  if (typeof a !== "object" || a === null) return undefined;
  const { type, choice, probabilities } = a as Record<string, unknown>;
  if (type !== "choice" || typeof choice !== "string" || !isSize(choice) || typeof probabilities !== "object" || probabilities === null) return undefined;
  const p = (probabilities as Record<string, unknown>)[choice];
  // `confidence` of a choice answer is a different, lower number: the calibration is on the probability
  return typeof p === "number" && Number.isFinite(p) ? { size: choice, probability: p } : undefined;
}

/**
 * Whether a string is a size.
 *
 * @param s - The string.
 * @returns True for `S`, `M`, `L` or `XL`.
 */
export function isSize(s: string): s is Size {
  return (SIZES as readonly string[]).includes(s);
}

/** What the plain model call is told. */
export const MODEL_SYSTEM = "You size software tasks. Answer with the option name only (S, M, L or XL), nothing else.";

/** The part of the model prompt after the task: instructions and the options. */
const MODEL_TAIL = `\n\n${INSTRUCTIONS}\n\nOptions:\n${SIZES.map((s) => `${s}: ${OPTIONS[s]}`).join("\n")}`;

/**
 * The prompt of the plain model fallback.
 *
 * @param state - The task text and subsystem lines.
 * @returns The prompt.
 */
export function modelPrompt(state: string): string {
  return `Task:\n${state}${MODEL_TAIL}`;
}

/**
 * Reads a plain model answer.
 *
 * @param text - The model's reply.
 * @returns The size at its start, or undefined.
 */
export function readModelSize(text: string): Size | undefined {
  const m = /^(XL|S|M|L)\b/.exec(text.trim());
  return m ? (m[1] as Size) : undefined;
}

/**
 * The text of a `$.tool.call` result (a hook-served tool answers a string `result`, a real MCP tool text parts).
 *
 * @param r - The result.
 * @returns The text, or undefined for a refusal, an error or a result without text.
 */
export function textOf(r: ToolResult): string | undefined {
  if (r.deny !== undefined || r.isError === true) return undefined;
  if (typeof r.text === "string" && r.text !== "") return r.text;
  if (typeof r.result === "string") return r.result || undefined;
  if (!Array.isArray(r.result)) return undefined;
  const parts = (r.result as unknown[]).map((p) => (typeof p === "object" && p !== null && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : "")).filter((t) => t !== "");
  return parts.length ? parts.join("\n") : undefined;
}
