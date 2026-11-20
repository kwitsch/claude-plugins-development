// What the fake Jev of jevfort answers, shared by tests/support/kit.ts (vitest, claude-engine-vitest) and
// register.test.ts (`claude plugin test`). No imports: `claude plugin test` runs it from a temp copy without node_modules.

/** jev-api's request tool, the name jevfort asks Jev through (equals `JEV_REQUEST` of src/hooks/jev.ts; tests/jev.test.ts would fail on drift of the source). */
export const REQUEST_TOOL = "mcp__jev-api__request";

/**
 * The id of a request question by its instructions (the start of each question jevfort asks).
 *
 * @param instructions - The question's instructions text.
 * @returns The id, or undefined for a question this kit does not know.
 */
export function questionId(instructions: string): string | undefined {
  const starts: [string, string][] = [
    ["An AI coding model works on the user request in `request` and ran its last step", "step_effort"],
    ["An AI coding assistant is working on the user request in `request`", "next_action"],
    ["Can the user request in `request` be fully answered", "single_action"],
    ["How much reasoning effort does a mid-tier AI coding model", "effort"],
    ["Is the user request in `request` a purely mechanical task", "mechanical"],
    ["An AI coding assistant just ended a turn.", "end"],
  ];
  return starts.find(([start]) => instructions.startsWith(start))?.[1];
}

/** What the fake answers a question the test leaves open, by type: not true, leave it to Claude, an unconfident score. */
export const NEUTRAL: Record<string, Record<string, unknown>> = {
  noul: { type: "noul", noul: 0 },
  choice: { type: "choice", choice: "claude", probabilities: { claude: 1 }, confidence: 1 },
  score: { type: "score", score: 0, probabilities: {}, confidence: 0 },
};
