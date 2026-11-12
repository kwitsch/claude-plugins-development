/**
 * Phase 3: before a compaction, Jev scores how relevant each recent tool result is to the current work. The ranking
 * drops no message (that could break tool call/result pairs); the summarizer is told what to keep in detail. Also the
 * transcript text and system prompt of a Haiku-written compaction (`haikuTranscript`), whose one summary message
 * replaces the whole conversation. Pure: the `session.compact` hook lives in `register.mts`.
 *
 * @packageDocumentation
 */
import { clip } from "./context.mjs";
import type { SessionMessage } from "./context.mjs";

/** How many tool results are scored (the last ones). */
export const MAX_ITEMS = 30;
/** The relevance levels, index 0–3. */
export const RELEVANCE = [
  "Irrelevant now: superseded, exploratory, or about finished work",
  "Background: useful context but details can be summarized",
  "Relevant: needed to continue the current work",
  "Essential: exact details (paths, errors, decisions, values) must be kept",
];

/** One tool result to score. */
export type Item = {
  /** The tool call id. */
  id: string;
  /** `Tool target`, as the instructions name it. */
  label: string;
  /** The result text, clipped. */
  result: string;
};

/**
 * The tool results of the transcript, newest {@link MAX_ITEMS}.
 *
 * @param messages - The transcript being compacted.
 * @returns The items.
 */
export function compactItems(messages: readonly SessionMessage[]): Item[] {
  const items: Item[] = [];
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const u of m.toolUses) {
      const target = typeof u.input.file_path === "string" ? u.input.file_path : typeof u.input.command === "string" ? clip(u.input.command, 80) : clip(JSON.stringify(u.input), 80);
      items.push({ id: u.tool_use_id, label: `${u.tool} ${target}`, result: clip(u.text ?? "", 500) });
    }
  }
  return items.slice(-MAX_ITEMS);
}

/**
 * The summarizer instructions from Jev's scores: keep ≥ 2.2 in detail, < 0.8 may be dropped.
 *
 * @param items - The scored items.
 * @param scores - Jev's score per item (`undefined` when unanswered).
 * @returns The instructions, or `undefined` when nothing stands out.
 */
export function compactInstructions(items: readonly Item[], scores: readonly (number | undefined)[]): string | undefined {
  const keep = items.filter((_, i) => (scores[i] ?? 0) >= 2.2).map((i) => i.label);
  const drop = items.filter((_, i) => scores[i] !== undefined && scores[i] < 0.8).map((i) => i.label);
  if (!keep.length && !drop.length) return undefined;
  const lines = ["Relevance ranking from Jev:"];
  if (keep.length) lines.push(`Keep exact details (paths, errors, decisions, values) from: ${keep.join("; ")}.`);
  if (drop.length) lines.push(`These are no longer relevant and can be reduced to a word or dropped: ${drop.join("; ")}.`);
  return lines.join("\n");
}

/** The summarizer model of a Haiku compaction. */
export const COMPACT_MODEL = "claude-haiku-5-5";
/** The transcript's most text sent to Haiku: about 600k tokens, inside its window with room for the summary. */
/** The most tokens Haiku may write for a summary; a reply that uses all of them was cut off. */
export const COMPACT_MAX_TOKENS = 16_000;
const COMPACT_MAX_CHARS = 2_400_000;
/** The last messages go to Haiku nearly whole: the work in progress lives in their tool calls and results. */
const COMPACT_TAIL = 6;
/** The system prompt of a Haiku compaction. */
export const COMPACT_SYSTEM = `You compact a conversation between a user and Claude Code, an AI coding agent, so the work can continue
in a fresh context that holds only your summary. Whoever reads it next knows nothing else about the conversation.

Write a detailed summary with these sections:
1. Primary request and intent: everything the user asked for, in detail, including changes of mind.
2. Key technical concepts: technologies, frameworks, constraints and decisions.
3. Files and code: every file read, created or edited, why it matters, and the important snippets or signatures.
4. Errors and fixes: what went wrong, how it was fixed, and any feedback the user gave about it.
5. Problem solving: what was solved and what is still being worked out.
6. All user messages: every message the user wrote that is not a tool result, briefly and in order.
7. Pending tasks: what the user asked for that is not done.
8. Current work: exactly what was being done right before this summary, with file names and code. The last few
messages come nearly uncut: carry the code and errors from them over in full, since the next step builds on them.
9. Next step: the next step, only if it follows directly from the user's latest request, quoting that request.

Be precise: keep names, paths, numbers, commands and error messages exact. Leave out pleasantries.
Reply with the summary only.`;

/**
 * The transcript as plain text for the summarizer: each message, its tool calls and their results, the long ones cut.
 *
 * @remarks
 * The engine lists a result twice: on the assistant row's call (`toolUses[].text`) and on the user row that carries it
 * (`toolResults[]`). It is printed once, from the user row, so it gets the cut of the row it arrived in; the call's
 * own text is used only when no user row carries the result yet.
 *
 * @param messages - The transcript.
 * @param toolChars - Characters kept of an older tool result.
 * @param tailChars - Characters kept of a tool input or result in the last {@link COMPACT_TAIL} messages.
 * @returns The text.
 */
export function compactTranscript(messages: readonly SessionMessage[], toolChars = 2000, tailChars = 20_000): string {
  const tailFrom = messages.length - COMPACT_TAIL;
  const carried = new Set(messages.flatMap((m) => (m.toolResults ?? []).map((r) => r.tool_use_id)));
  return messages
    .map((m, i) => {
      const tail = i >= tailFrom;
      const resultChars = tail ? tailChars : toolChars;
      const lines = [`${m.role === "user" ? "USER" : "CLAUDE"}: ${m.text}`.trimEnd()];
      for (const t of m.toolUses) {
        lines.push(`  [${t.tool} ${clip(JSON.stringify(t.input), tail ? tailChars : 400)}]`);
        if (t.text && !carried.has(t.tool_use_id)) lines.push(`  → ${clip(t.text, resultChars)}`);
      }
      for (const r of m.toolResults ?? []) if (r.text) lines.push(`  → ${clip(r.text, resultChars)}`);
      return lines.join("\n");
    })
    .join("\n\n");
}

/**
 * The transcript for Haiku, shortened once when it is too long.
 *
 * @param messages - The transcript.
 * @returns The text, or `undefined` when even the short form is too long.
 */
export function haikuTranscript(messages: readonly SessionMessage[]): string | undefined {
  let t = compactTranscript(messages);
  if (t.length > COMPACT_MAX_CHARS) t = compactTranscript(messages, 300, 4000);
  return t.length > COMPACT_MAX_CHARS ? undefined : t;
}
