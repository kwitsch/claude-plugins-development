/**
 * The prompts the calibration compares: the request (state and questions) as a function of the task, and how the
 * answers become a size and a confidence. Only the baseline and the shipped question are kept; the rejected wordings
 * and their numbers are in `development/wiki/plugins/taskflow/design/size-calibration.md`.
 *
 * - `v0`: the old `score` question ("How large is the work?" over four short criteria), accepted at confidence 0.6.
 * - `c8`: the shipped `choice` question (its one source is `src/hooks/size.ts`), read as `probabilities[choice]`.
 *
 * Each also exists as `<name>:nosubs`: the task text only (the subsystem lines of the corpus are hand-written, so a
 * result must not depend on them).
 */

import { buildState, INSTRUCTIONS, OPTIONS, SIZES } from "../src/hooks/size.ts";
import type { Size } from "../src/hooks/size.ts";
import type { Item } from "./size-calibration-corpus.ts";

type Answer = Record<string, unknown>;

export type Prompt = {
  state: string;
  questions: Record<string, unknown>;
  /** Maps the answers (in question order) to a size and the confidence the skill would test against its threshold. */
  decide: (answers: Answer[]) => { size: Size; confidence: number };
};

const num = (v: unknown): number => (typeof v === "number" ? v : Number.NaN);

const OLD_CRITERIA = ["S: a few lines in one place", "M: one component", "L: several functionalities, modules or subprojects", "XL: cross-cutting or architectural"];

const BASE: Record<string, (item: Item) => Prompt> = {
  v0: (item) => ({
    state: buildState(item.text, item.subs),
    questions: { q0: { type: "score", instructions: "How large is the work?", criteria: OLD_CRITERIA } },
    decide: ([a]) => ({ size: SIZES[Math.min(3, Math.max(0, Math.round(num(a?.["score"]))))], confidence: num(a?.["confidence"]) }),
  }),
  c8: (item) => ({
    state: buildState(item.text, item.subs),
    questions: { q0: { type: "choice", instructions: INSTRUCTIONS, criteria: OPTIONS } },
    decide: ([a]) => {
      const pick = String(a?.["choice"]) as Size;
      return { size: pick, confidence: num((a?.["probabilities"] as Record<string, unknown> | undefined)?.[pick]) };
    },
  }),
};

export const VARIANTS: Record<string, (item: Item) => Prompt> = Object.fromEntries(
  Object.entries(BASE).flatMap(([name, make]) => [[name, make], [`${name}:nosubs`, (item: Item) => make({ ...item, subs: [] })]]),
);
