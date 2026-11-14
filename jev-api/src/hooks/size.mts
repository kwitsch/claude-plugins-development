/**
 * How large a prompt System One takes: the measured limits, the optimistic preflight estimate, the latency budget, the state cut, the server's context refusal and the characters-per-token density learned across sessions.
 *
 * @packageDocumentation
 */

import type { Engine, ToolName, ToolResult } from "./types.mjs";
import { MAX_TIMEOUT_S, fail, isRecord, json } from "./util.mjs";

/** The context window of System One in tokens (`n_ctx`, measured live 2026-11-14: a prompt of this many tokens is refused, one less passes). The server's own `n_ctx` replaces it once a rejection reports it. */
export const DEFAULT_CONTEXT_TOKENS = 32768;

/** The tokens of an otherwise empty request (measured live 2026-11-14), counted on top of the state and the questions. */
export const PROMPT_OVERHEAD_TOKENS = 26;

/** Characters per token assumed before anything is learned: typical text measures 3.3 (minified JS) to 4.8 (English prose), so cuts and messages stay on the safe side. */
export const DEFAULT_DENSITY = 3;

/** The lowest learned characters per token: emoji, `€` and CJK cost one token per UTF-16 unit and no text measured below it. */
export const MIN_DENSITY = 1;

/** The highest characters per token: repetitive text measures 8, nothing real comes near it. */
export const MAX_DENSITY = 8;

/** The weight of the newest sample in the learned density. */
export const DENSITY_ALPHA = 0.2;

/** A prompt under this many tokens teaches nothing: the fixed overhead and the question dominate it. */
export const MIN_SAMPLE_TOKENS = 400;

/** A learned density is written to the store only when it moved by more than this share of the stored one. */
export const PERSIST_DELTA = 0.1;

/** The `$.store` key of the learned density, `{ v: charsPerToken, n: samples }`. */
export const DENSITY_KEY = "density";

/** How long the first call waits for the stored density (ms) before it goes on without it. */
export const STORE_WAIT_MS = 1000;

/** Tokens kept free below the limit when a state is cut or a size is named (the estimate is a ratio, not a tokenizer). */
export const CUT_MARGIN_TOKENS = 64;

/** The `error.type` System One answers a prompt over its context window with (HTTP 400). */
export const CONTEXT_ERROR = "exceed_context_size_error";

/** The reject test assumes at most this many times the learned characters per token, never less than {@link DEFAULT_DENSITY} (capped at {@link MAX_DENSITY}): a call is refused before sending only when even this optimistic estimate does not fit. */
export const OPTIMISTIC_FACTOR = 2;

/**
 * System One's latency in ms for a prompt of `t` tokens: `LATENCY_LINEAR_MS * t + LATENCY_QUADRATIC_MS * t^2`, times
 * {@link LATENCY_MARGIN}. Measured live 2026-11-14 for model `d1-3b` on an idle endpoint (4k tokens 2.9 s, 16k 15 s, 28k 35 s,
 * 32767 tokens 42 s; held-out points within 0.9 to 1.3 of the fit).
 */
export const LATENCY_LINEAR_MS = 0.7;

/** The quadratic term of the latency model, see {@link LATENCY_LINEAR_MS}. */
export const LATENCY_QUADRATIC_MS = 1.8e-5;

/** The safety factor of the latency model: the measured spread was up to 1.31. */
export const LATENCY_MARGIN = 1.3;

/** The smallest token budget a timeout gives: the budget never shrinks below this, so a probe-sized timeout does not refuse prompts of this size or smaller. */
export const MIN_BUDGET_TOKENS = 1000;

/** The share of the kept characters of a cut state that comes from its start (the rest is its end). */
export const HEAD_SHARE = 0.6;

/** What a module instance knows about System One's size limits; learned from answers, the density kept across sessions. */
export type Knowledge = {
  /** Learned characters per token. */
  density: number;
  /** The density as last written to (or read from) the store. */
  persisted: number;
  /** How many samples the density holds. */
  samples: number;
  /** The server's context window in tokens. */
  nctx: number;
  /** The read of the stored density: started by the first call, shared by the others. */
  loaded: Promise<void> | undefined;
};

/** The server's refusal of a prompt over its context window, with the numbers the plugin needs to react. */
export type TooBig = {
  /** Always present: tells the refusal from a tool result. */
  tooBig: {
    /** The exact tokens of the refused prompt (`n_prompt_tokens`). */
    tokens: number;
    /** The most tokens the server takes: its `n_ctx` minus one. */
    limit: number;
    /** The characters of the prompt: the state plus the questions JSON. */
    chars: number;
    /** The characters of the questions JSON alone. */
    questionsChars: number;
  };
};

/**
 * Whether an answer of {@link ask} is the server's context refusal.
 *
 * @param r - The answer.
 * @returns True for a {@link TooBig}.
 */
export function isTooBig(r: ToolResult | TooBig): r is TooBig {
  return isRecord((r as Partial<TooBig>).tooBig);
}

/**
 * Reads the stored density once per module instance and waits for it at most {@link STORE_WAIT_MS}; every failure
 * (a missing key, a refused or hanging store, a value out of range) leaves the default in place.
 *
 * @param $ - The engine.
 * @param k - What the module knows; its `loaded` is set by the first call.
 * @returns A promise that never rejects.
 */
export function loadKnowledge($: Engine, k: Knowledge): Promise<void> {
  k.loaded ??= (async () => {
    let timer: { cancel(): void } | undefined;
    try {
      const read = Promise.resolve($.store.get(DENSITY_KEY));
      read.catch(() => undefined); // a late rejection after the wait must not go unhandled
      const late = new Promise<undefined>((resolve) => {
        timer = $.clock.after(STORE_WAIT_MS, () => resolve(undefined));
      });
      const stored = await Promise.race([read, late]);
      const v = isRecord(stored) ? stored["v"] : undefined;
      if (typeof v === "number" && Number.isFinite(v) && v >= MIN_DENSITY && v <= MAX_DENSITY && k.samples === 0) {
        k.density = v;
        k.persisted = v;
        const n = isRecord(stored) ? stored["n"] : undefined;
        k.samples = typeof n === "number" && Number.isInteger(n) && n > 0 ? n : 0;
      }
    } catch {
      // best effort: the default density and an unreachable store must not fail a call
    } finally {
      timer?.cancel();
    }
  })();
  return k.loaded;
}

/**
 * Folds one measured prompt into the learned density and writes it to the store when it moved far enough. A prompt
 * under {@link MIN_SAMPLE_TOKENS} tokens or a count that is not a number teaches nothing.
 *
 * @param $ - The engine.
 * @param k - What the module knows; updated.
 * @param chars - The characters of the prompt: the state plus the questions JSON.
 * @param tokens - The tokens the server counted for it.
 */
export function learn($: Engine, k: Knowledge, chars: number, tokens: unknown): void {
  if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < MIN_SAMPLE_TOKENS) return;
  const sample = chars / (tokens - PROMPT_OVERHEAD_TOKENS);
  if (!Number.isFinite(sample)) return;
  k.density = (1 - DENSITY_ALPHA) * k.density + DENSITY_ALPHA * Math.min(MAX_DENSITY, Math.max(MIN_DENSITY, sample));
  k.samples += 1;
  if (Math.abs(k.density - k.persisted) / k.persisted <= PERSIST_DELTA) return;
  k.persisted = k.density;
  try {
    // not awaited: a statistic must not hold an answer; a failing store only loses it
    void Promise.resolve($.store.set(DENSITY_KEY, { v: k.density, n: k.samples })).catch(() => undefined);
  } catch {
    // best effort
  }
}

/**
 * The tokens a timeout allows: the positive root of the latency model (see {@link LATENCY_LINEAR_MS}), at least {@link MIN_BUDGET_TOKENS}.
 *
 * @param timeoutMs - The request timeout in milliseconds.
 * @returns Whole tokens.
 */
export function timeBudgetTokens(timeoutMs: number): number {
  const a = LATENCY_LINEAR_MS * LATENCY_MARGIN;
  const b = LATENCY_QUADRATIC_MS * LATENCY_MARGIN;
  return Math.max(MIN_BUDGET_TOKENS, Math.floor((-a + Math.sqrt(a * a + 4 * b * timeoutMs)) / (2 * b)));
}

/**
 * The tokens of a prompt of `chars` characters at `density` characters per token, plus the fixed overhead.
 *
 * @param chars - The characters of the prompt.
 * @param density - Characters per token.
 * @returns Whole tokens.
 */
export function estimateTokens(chars: number, density: number): number {
  return Math.ceil(chars / density) + PROMPT_OVERHEAD_TOKENS;
}

/**
 * Cuts the middle out of a state: {@link HEAD_SHARE} of `keep` from its start, the rest from its end, with a marker
 * naming what was dropped. Measured in UTF-16 units (what the token estimate counts); a surrogate pair is never split.
 *
 * @param state - The text.
 * @param keep - How many characters of it stay (at least 0).
 * @returns The state itself when it is not longer than `keep`, else head, marker and tail.
 */
export function cutState(state: string, keep: number): string {
  if (state.length <= keep) return state;
  const headLength = Math.round(keep * HEAD_SHARE);
  const tailLength = keep - headLength;
  let head = state.slice(0, headLength);
  const last = head.charCodeAt(head.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1); // not a lone high surrogate
  let tail = tailLength > 0 ? state.slice(-tailLength) : "";
  const first = tail.charCodeAt(0);
  if (first >= 0xdc00 && first <= 0xdfff) tail = tail.slice(1); // not a lone low surrogate
  return `${head}\n[... ${state.length - head.length - tail.length} characters omitted ...]\n${tail}`;
}

/**
 * The characters of the state that fit `budget` tokens at the learned density, with the margin kept free.
 *
 * @param budget - The tokens the prompt may have.
 * @param density - Learned characters per token.
 * @param questionsChars - The characters of the questions JSON.
 * @returns Whole characters, at least 0.
 */
export function stateForBudget(budget: number, density: number, questionsChars: number): number {
  return Math.max(0, Math.floor((budget - PROMPT_OVERHEAD_TOKENS - CUT_MARGIN_TOKENS) * density) - questionsChars);
}

/**
 * Reads System One's refusal of a prompt over its context window: HTTP 400, `error.type` `exceed_context_size_error`,
 * with the exact token count of the prompt and the context size as whole numbers.
 *
 * @param text - The raw response body.
 * @returns The refused prompt's tokens and the server's context window, or undefined for any other body.
 */
export function contextRefusal(text: string): { tokens: number; nctx: number } | undefined {
  const body = json(text);
  const error = isRecord(body) ? body["error"] : undefined;
  if (!isRecord(error) || error["type"] !== CONTEXT_ERROR) return undefined;
  const tokens = error["n_prompt_tokens"];
  const nctx = error["n_ctx"];
  if (typeof tokens !== "number" || typeof nctx !== "number" || !Number.isInteger(tokens) || !Number.isInteger(nctx) || nctx < 2 || tokens < nctx) return undefined;
  return { tokens, nctx };
}

/**
 * The exact characters per token of a prompt the server refused: its characters over the tokens it counted, less the
 * fixed overhead.
 *
 * @param refused - The server's refusal with the prompt's size.
 * @returns Characters per token; use it with {@link stateForBudget} instead of the learned density.
 */
export function refusedDensity(refused: TooBig["tooBig"]): number {
  return refused.chars / (refused.tokens - PROMPT_OVERHEAD_TOKENS);
}

/**
 * A state size to name in an error: rounded down to whole hundreds of characters.
 *
 * @param chars - The characters that fit.
 * @returns Whole hundreds, at least 0.
 */
export function aimHundreds(chars: number): number {
  return Math.floor(chars / 100) * 100;
}

/**
 * The refusal a tool answers when the prompt is over the server's context window and nothing else is done about it.
 *
 * @param tool - The tool called.
 * @param refused - The server's refusal with the prompt's size.
 * @returns The error answer: the exact numbers and the state size to aim for (in hundreds of characters).
 */
export function tooBigError(tool: ToolName, refused: TooBig["tooBig"]): ToolResult {
  const aim = aimHundreds(stateForBudget(refused.limit, refusedDensity(refused), refused.questionsChars));
  return fail(tool, `state too large for System One: the request has ${refused.tokens} tokens, the limit is ${refused.limit}; shorten the state to about ${aim} characters`);
}

/**
 * The refusal a tool answers when the preflight finds the prompt too large and the overflow mode is `error`: nothing was sent.
 *
 * @param tool - The tool called.
 * @param estimate - The optimistic token estimate of the prompt (a lower bound).
 * @param budget - The tokens the prompt may have: the smaller of the server's limit and what the timeout allows.
 * @param limit - The server's limit in tokens (its `n_ctx` minus one).
 * @param timeoutMs - The request timeout.
 * @param aim - The state size to aim for, in characters.
 * @returns The error answer; it names the timeout when the timeout, not the server's limit, set the budget.
 */
export function preflightError(tool: ToolName, estimate: number, budget: number, limit: number, timeoutMs: number, aim: number): ToolResult {
  if (budget >= limit) return fail(tool, `state too large for System One: at least ${estimate} tokens, the limit is ${limit}; shorten the state to about ${aimHundreds(aim)} characters`);
  // At the floor the timeout allows fewer tokens than the budget, so naming the budget as what fits would be false.
  const fit = budget > MIN_BUDGET_TOKENS ? `, about ${budget} fit` : "";
  return fail(tool, `state too large for the timeout of ${timeoutMs / 1000} s: at least ${estimate} tokens${fit}; shorten the state to about ${aimHundreds(aim)} characters or raise the timeout (at most ${MAX_TIMEOUT_S} s)`);
}
