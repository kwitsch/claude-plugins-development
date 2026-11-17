#!/usr/bin/env node
// Stop command hook: blocks the end of a main-session turn whose closing paragraph asks a plain-text question, once. The
// CRITICAL RULE it points at is injected by session-start.ts. Subagents are never gated: their payload carries
// `agent_id` (and their stops are SubagentStop events, which are not wired).

/** The `reason` Claude Code hands back to the model; short, it names the rule instead of repeating it. */
const REASON = "Interaction rule violation: the final response ends with a plain-text question to the user. "
  + "Redo it through the AskUserQuestion tool (the CRITICAL RULE from the session start), no exceptions, not even a casual yes/no offer.";

/** The part of the Stop payload this hook reads. */
type StopInput = {
  /** True when a Stop hook (any plugin's) already made this stop continue: never block twice. */
  stop_hook_active?: boolean;
  /** Set only inside a subagent. */
  agent_id?: string;
  /** The turn's final visible text. */
  last_assistant_message?: string;
};

/**
 * True when the last paragraph of the answer holds a question: a `?` followed by whitespace or the end, outside fenced
 * code, inline code and quoted (`>`) lines. A question in an earlier paragraph passes, a rhetorical `?` in the last
 * one is an accepted false positive.
 *
 * @param answer - The turn's final visible text.
 * @returns Whether the closing paragraph asks something.
 */
const endsInQuestion = (answer: string): boolean => {
  const text = answer
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`\n]*`/g, "")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith(">"))
    .join("\n")
    .trim();
  const last = text.split(/\n\s*\n/).pop() ?? "";
  return /\?(\s|$)/.test(last);
};

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  raw += chunk;
});
process.stdin.on("end", () => {
  let input: StopInput = {};
  try {
    input = JSON.parse(raw) as StopInput;
  } catch {
    // An unreadable payload never blocks: the hook fails open.
  }
  if (input.stop_hook_active === true || input.agent_id !== undefined || typeof input.last_assistant_message !== "string") return;
  if (endsInQuestion(input.last_assistant_message)) process.stdout.write(JSON.stringify({ decision: "block", reason: REASON }));
});
