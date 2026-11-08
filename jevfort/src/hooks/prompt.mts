/**
 * Phase 3: classify each prompt as it is sent and, when Jev is confident, add a short hint only Claude reads (a
 * skill that fits, or plan first). Pure: the `prompt.submit` hook and the skill list (`skillOptions`) live in
 * `register.mts`.
 *
 * @packageDocumentation
 */
import type { Question } from "./jev.mjs";

/** The skill option meaning "no listed skill fits". */
export const NONE = "none";
/** The prompt kinds Jev picks from. */
export const KIND_LEVELS: Record<string, string> = {
  question: "Asks for an explanation, information or an opinion; no change is needed",
  task: "Asks for a change: writing, editing, fixing or building something",
  command: "Asks to run, show or check one specific thing (tests, status, a file)",
  conversation: "Small talk, thanks, or a reply to the assistant with no new request",
};
/** A skill at or above this probability (and below the take threshold) gets a hint. */
export const SKILL_HINT = 0.6;
/** A task whose plan-first probability is at or above this gets a hint. */
export const PLAN_HINT = 0.85;

/**
 * The classifier's questions: the prompt kind, whether it needs a plan, and (with skills) which skill fits.
 *
 * @param skills - The skill options, or `undefined` when none is listed.
 * @returns The questions.
 */
export function promptQuestions(skills: Record<string, string | null> | undefined): Record<string, Question> {
  const questions: Record<string, Question> = {
    kind: {
      type: "choice",
      instructions: "What kind of message is `request`, sent to an AI coding assistant? When `previous_reply` is present, `request` answers it: read a short follow-up like 'fix it' or 'yes' in that light.",
      criteria: KIND_LEVELS,
    },
    needs_plan: {
      type: "noul",
      instructions: "Is `request` a large or ambiguous change (several files, design choices, unclear scope) that the assistant should plan and confirm before editing anything? When `previous_reply` is present, `request` refers to it: a follow-up approving or naming a change already described there is not ambiguous.",
      criteria: { true: "Large or ambiguous: plan first", false: "Small, clear, or not a change at all" },
    },
  };
  if (skills) questions.skill = { type: "choice", instructions: "Which listed skill is squarely meant for `request`, if any?", criteria: skills };
  return questions;
}

/**
 * The hints to add to the prompt's context.
 *
 * @param kind - The prompt kind.
 * @param needsPlan - The plan-first probability.
 * @param skill - The best skill and its probability.
 * @param takeThreshold - From this probability on Jev takes the skill itself at step 0, so no hint.
 * @returns The hint lines.
 */
export function hints(kind: string | undefined, needsPlan: number | undefined, skill: { name: string; p: number } | undefined, takeThreshold: number): string[] {
  const out: string[] = [];
  if (skill && skill.name !== NONE && skill.p >= SKILL_HINT && skill.p < takeThreshold) {
    out.push(`Jev routing hint: the skill "${skill.name}" looks like a fit for this request (p=${skill.p.toFixed(2)}). Consider invoking it.`);
  }
  if (kind === "task" && (needsPlan ?? 0) >= PLAN_HINT) {
    out.push(`Jev routing hint: this looks like a large or ambiguous change (p=${(needsPlan ?? 0).toFixed(2)}). Outline a short plan and confirm it with the user before editing.`);
  }
  return out;
}
