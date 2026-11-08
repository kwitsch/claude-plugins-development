/**
 * Phase 3: before a compaction, Jev scores how relevant each recent tool result is to the current work. No message
 * is dropped (that could break tool call/result pairs); the summarizer is told what to keep in detail. Pure: the
 * `session.compact` hook lives in `register.mts`.
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
