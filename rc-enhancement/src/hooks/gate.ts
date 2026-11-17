/**
 * The interaction gate's text and question heuristic.
 *
 * @packageDocumentation
 */

/** The prompt the gate submits. It points at the CRITICAL RULE of `bin/session-start.ts`, and the turn it starts is recognized by this text. */
export const GATE_REASON = "Interaction rule violation: the final response ends with a plain-text question to the user. "
  + "Follow the CRITICAL RULE from the session start (how to interact with the user): "
  + "route the question through the AskUserQuestion tool instead — no exceptions, not even a casual yes/no offer.";

/**
 * True when the last non-empty line outside fenced code blocks ends in `?`. A rhetorical trailing `?` is an accepted
 * false positive.
 *
 * @param answer - The turn's final visible text.
 * @returns Whether the answer ends in a bare question.
 */
export const isBareQuestion = (answer: string): boolean => {
  const lines = answer
    .replace(/```[\s\S]*?```/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return /\?\s*$/.test(lines[lines.length - 1] ?? "");
};
