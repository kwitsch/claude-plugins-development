/**
 * The turn as Jev sees it: the request, the steps after it, and compact summaries. Pure; the transcript read
 * (`readTurn`, `previousReply`) lives in `register.mts`.
 *
 * @packageDocumentation
 */

/** One tool call of an assistant message, with its outcome once known. */
export type ToolUse = {
  /** The call's id. */
  tool_use_id: string;
  /** The tool name. */
  tool: string;
  /** The call's input. */
  input: Record<string, unknown>;
  /** The result text, once the tool ran. */
  text?: string;
  /** Whether the tool failed. */
  isError?: boolean;
};

/** One tool result of a user message. */
export type ToolResultRow = {
  /** The call it answers. */
  tool_use_id: string;
  /** The result text. */
  text: string;
  /** Whether the tool failed. */
  isError: boolean;
};

/** A transcript row as the session transcript lists it (the fields this plugin reads). */
export type SessionMessage = {
  /** Who wrote it. */
  role: "user" | "assistant";
  /** Its text. */
  text: string;
  /** The assistant's tool calls (empty for a user row). */
  toolUses: ToolUse[];
  /** A user row's tool results. */
  toolResults?: ToolResultRow[];
};

/** The request a turn answers and the steps taken so far. */
export type TurnContext = {
  /** The user's request this turn answers. */
  request: string;
  /** Messages after the request: the turn's steps so far. */
  steps: SessionMessage[];
};

/** One step as Jev's `recent` lists it: an assistant text, or a tool call with its outcome. */
export type StepSummary = { assistant?: string; tool?: string; input?: string; result?: string; isError?: true };

/**
 * `text` cut to `max` characters with a note of what was dropped.
 *
 * @param text - The text.
 * @param max - The maximum length kept.
 * @returns The text, clipped when longer than `max`.
 */
export const clip = (text: string, max: number): string => text.length > max ? `${text.slice(0, max)}… [${text.length - max} more chars]` : text;

/**
 * Rows the person didn't type as a request: `!` shell runs, slash-command output, and the engine's notices
 * (background task results, reminders).
 */
const TRANSCRIPT_ONLY = /^\s*<(bash-input|bash-stdout|bash-stderr|local-command-stdout|local-command-caveat|command-name|command-message|system-reminder|task-notification)>/;

/**
 * The last user message that carries text and no tool results is the request.
 *
 * @param messages - The transcript.
 * @returns The request and the steps after it, or `undefined` without a request.
 */
export function splitTurn(messages: readonly SessionMessage[]): TurnContext | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user" && m.text.trim() !== "" && !m.toolResults?.length && !TRANSCRIPT_ONLY.test(m.text)) {
      return { request: m.text, steps: messages.slice(i + 1) };
    }
  }
  return undefined;
}

/**
 * The turn's tool calls in order, with their outcomes.
 *
 * @param steps - The turn's steps.
 * @returns Every tool call of every assistant row.
 */
export function toolCalls(steps: readonly SessionMessage[]): ToolUse[] {
  return steps.flatMap((m) => (m.role === "assistant" ? m.toolUses : []));
}

/**
 * A compact view of the last `limit` steps for Jev's state.
 *
 * @param steps - The turn's steps.
 * @param limit - How many summaries to keep (the last ones).
 * @returns The summaries.
 */
export function summarize(steps: readonly SessionMessage[], limit = 8): StepSummary[] {
  const out: StepSummary[] = [];
  for (const m of steps) {
    if (m.role !== "assistant") continue;
    if (m.text.trim()) out.push({ assistant: clip(m.text, 400) });
    for (const use of m.toolUses) {
      out.push({
        tool: use.tool,
        input: clip(JSON.stringify(use.input), 300),
        ...(use.text !== undefined ? { result: clip(use.text, 400) } : {}),
        ...(use.isError ? { isError: true as const } : {}),
      });
    }
  }
  return out.slice(-limit);
}
