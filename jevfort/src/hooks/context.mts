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
  /** True when a slash command started the turn: `request` is the command as typed, its skill text is not in the transcript. */
  command?: true;
};

/** One step as Jev's `recent` lists it: an assistant text, or a tool call with its outcome. */
export type StepSummary = { assistant?: string; tool?: string; input?: string; result?: string; isError?: true };

/**
 * The first `n` UTF-16 units of `text`, without a high surrogate left by the cut (a split astral character renders as U+FFFD).
 *
 * @param text - The text.
 * @param n - The length kept.
 * @returns The cut text.
 */
export const head = (text: string, n: number): string => text.slice(0, n).replace(/[\uD800-\uDBFF]$/, "");

/**
 * `text` cut to `max` characters with a note of what was dropped.
 *
 * @param text - The text.
 * @param max - The maximum length kept.
 * @returns The text, clipped when longer than `max`.
 */
export const clip = (text: string, max: number): string => {
  if (text.length <= max) return text;
  const kept = head(text, max);
  return `${kept}… [${text.length - kept.length} more chars]`;
};

/**
 * Rows the person didn't type as a request: `!` shell runs, slash-command output, and the engine's notices
 * (background task results, reminders). See {@link isTranscriptOnly}.
 */
const TRANSCRIPT_ONLY = /^\s*<(bash-input|bash-stdout|bash-stderr|local-command-stdout|local-command-caveat|command-name|command-message|command-args|system-reminder|task-notification)>/;

/**
 * Whether a row is the engine's own notice rather than something the person typed: it starts with one of those
 * tags and, after that tag's last closing tag, holds nothing or another tag. Text typed after a pasted tag makes the
 * row the person's request; an unclosed tag (a cut notice) stays a notice.
 *
 * @param text - The row's text.
 * @returns True for a transcript-only row.
 */
function isTranscriptOnly(text: string): boolean {
  const m = TRANSCRIPT_ONLY.exec(text);
  if (!m) return false;
  const close = `</${m[1]}>`;
  const end = text.lastIndexOf(close);
  if (end < 0) return true;
  const rest = text.slice(end + close.length).trim();
  // What follows must itself be notices all the way: a question after two pasted tags is the person's.
  return rest === "" || isTranscriptOnly(rest);
}

/**
 * The row of a slash command that started a turn (a skill typed as `/name args`): `<command-message>` first, then the
 * name and optional arguments, nothing else. The arguments group is greedy, so the row's last closing tag ends it
 * whatever the arguments contain. A local command such as `/jev` starts with `<command-name>` and starts no turn.
 * The name group takes its surrounding blanks and {@link typedCommand} trims them: a lazy group beside `\s*` backtracks
 * cubically on a long run of blanks (2000 of them took 2 s).
 */
const COMMAND_ROW = /^\s*<command-message>[\s\S]*?<\/command-message>\s*<command-name>([^<]*)<\/command-name>\s*(?:<command-args>([\s\S]*)<\/command-args>\s*)?$/;

/** How the row a compaction leaves begins. */
const COMPACT_SUMMARY = "This session is being continued from a previous conversation that ran out of context.";

/** The row Claude Code stores when the user presses Esc. */
const INTERRUPT = /^\[Request interrupted by user( for tool use)?\]$/;

/**
 * The slash command a row stands for, as typed.
 *
 * @param text - The row's text.
 * @returns `/name args`, or `undefined` when the row is not a command row.
 */
function typedCommand(text: string): string | undefined {
  const m = COMMAND_ROW.exec(text);
  const name = m?.[1]?.trim();
  if (!name) return undefined;
  const args = m?.[2]?.trim();
  return args ? `${name} ${args}` : name;
}

/**
 * The last user message that carries text and no tool results is the request; a slash command that started a turn
 * (`<command-message>` row, as a skill has) is the request as typed, not the prompt before it. A local command
 * (`<command-name>` row, as `/jev` has) is skipped like any transcript-only row.
 *
 * @param messages - The transcript.
 * @returns The request and the steps after it, or `undefined` without a request.
 */
export function splitTurn(messages: readonly SessionMessage[]): TurnContext | undefined {
  let summary: number | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user" || m.toolResults?.length) continue;
    const text = m.text.trim();
    // No request for this turn: an empty row (an image-only prompt), the user's interrupt marker, a `!` shell command.
    // The walk stops: an older prompt is not what this turn answers.
    if (text === "" || INTERRUPT.test(text) || (/^<bash-input>/.test(text) && isTranscriptOnly(text))) return undefined;
    // The summary a compaction leaves is no request; it stands in only when nothing typed is left before it.
    if (text.startsWith(COMPACT_SUMMARY)) {
      summary ??= i;
      continue;
    }
    const typed = typedCommand(m.text);
    if (typed) return { request: typed, command: true, steps: messages.slice(i + 1) };
    if (!isTranscriptOnly(m.text)) return { request: m.text, steps: messages.slice(i + 1) };
  }
  return summary === undefined ? undefined : { request: messages[summary].text, steps: messages.slice(summary + 1) };
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
  // From the end, so a long turn costs `limit` entries, not its whole length.
  for (let i = steps.length - 1; i >= 0 && out.length < limit; i--) {
    const m = steps[i];
    if (m.role !== "assistant") continue;
    const row: StepSummary[] = [];
    if (m.text.trim()) row.push({ assistant: clip(m.text, 400) });
    for (const use of m.toolUses) {
      row.push({
        tool: use.tool,
        input: clip(JSON.stringify(use.input), 300),
        ...(use.text !== undefined ? { result: clip(use.text, 400) } : {}),
        ...(use.isError ? { isError: true as const } : {}),
      });
    }
    out.unshift(...row);
  }
  return out.slice(-limit);
}
