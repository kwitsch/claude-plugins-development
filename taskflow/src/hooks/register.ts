/**
 * Claude Code function-hooks module of taskflow: registers the tool `size-task` (`mcp__taskflow__size-task`) that
 * bundles the size step of `build-task`. Input: the task text and optional subsystem lines. Output: the size letter
 * (`S`, `M`, `L`, `XL`) first, then where it came from.
 *
 * @remarks
 * Order: jev-api's `request` tool (the calibrated `choice` question, taken at `probabilities[choice] >= 0.5`), then a
 * plain model call with the same descriptions, then jev-api's unsure answer after all; a refusal only when nothing
 * answered. No engine type import: `types.ts` types the used `$` members structurally. Only this file uses `$`; the
 * wording, threshold and answer reading are pure (`size.ts`). Built to `plugin/hooks/register.js` (compressed, never
 * mangled).
 *
 * @packageDocumentation
 */

import { FALLBACK_MODEL, MIN_PROBABILITY, MODEL_SYSTEM, modelPrompt, parseInput, QUESTION, readAnswer, readModelSize, textOf } from "./size.js";
import type { Pick, Size } from "./size.js";
import type { Engine, On } from "./types.js";

/** The bare tool name. */
const TOOL = "size-task";

/** The full name the engine gives the tool. */
const FULL = `mcp__taskflow__${TOOL}`;

/** jev-api's tool. */
const JEV_REQUEST = "mcp__jev-api__request";

/** jev-api's own timeout for the request, in seconds. */
const JEV_TIMEOUT_S = 20;

/** How long the tool waits for jev-api (ms): its own timeout plus a margin; `$.tool.call` has no signal. */
const JEV_BUDGET_MS = JEV_TIMEOUT_S * 1000 + 5000;

/** How long the plain model call may take (ms). */
const MODEL_TIMEOUT_MS = 60_000;

/** How long a tool call waits for the registration (ms); `session.start` waits five times as long. */
const REGISTER_WAIT_MS = 1000;

/** What `$.tool.register` gets: the tool is deferred (found through ToolSearch). */
const SPEC: Parameters<Engine["tool"]["register"]>[0] = {
  name: TOOL,
  description: "Sizes a software task as S, M, L or XL (for build-task's size step): give the task text and, optionally, one line per affected subsystem. Answers the letter first, then where it came from.",
  isDeferred: true,
  inputSchema: {
    type: "object",
    properties: { task: { type: "string", description: "The task text." }, subsystems: { type: "array", items: { type: "string" }, description: "Optional, one line per affected subsystem: '<name> - <focus>'." } },
    required: ["task"],
  },
};

/** The registration state of one module instance. */
type RegState = {
  /** The full names this module answers. */
  names: Set<string>;
  /** Whether the tool is registered. */
  registered: boolean;
  /** The registration under way. */
  pending: Promise<void> | undefined;
  /** Whether a failed registration was logged already. */
  logged: boolean;
  /** Failed attempts since the last success. */
  failures: number;
  /** When a failed registration may be tried again (ms since epoch). */
  retryAt: number;
};

/** The delay before the second retry of a refused registration (ms); it doubles for every further one, up to {@link MAX_RETRY_MS}. The first retry is immediate (the session may only have been unbound). */
const RETRY_BASE_MS = 5000;

/** The longest a failed registration waits for its next try (ms). */
const MAX_RETRY_MS = 300_000;

/**
 * Waits for `p` at most `ms`; the timer is cancelled either way.
 *
 * @param $ - The engine.
 * @param ms - The longest wait.
 * @param p - What to wait for.
 * @param late - What the wait resolves to when the time is up.
 * @returns What `p` resolved to, or `late`.
 */
async function within<T, L>($: Engine, ms: number, p: Promise<T>, late: L): Promise<T | L> {
  let timer: { cancel(): void } | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<L>((resolve) => {
        timer = $.clock.after(ms, () => resolve(late));
      }),
    ]);
  } finally {
    timer?.cancel();
  }
}

/**
 * Starts the registration when the tool is missing and none is under way, then waits for it at most `ms`. Never
 * rejects (not even when the engine refuses the clock): a failed registration is tried again by the next hook.
 *
 * @param $ - The engine.
 * @param st - The registration state.
 * @param ms - The longest wait.
 */
async function ensureTool($: Engine, st: RegState, ms: number): Promise<void> {
  try {
    const now = Date.now();
    // A retry time further ahead than any back-off means the wall clock stepped back: try again at once.
    if (st.retryAt - now > MAX_RETRY_MS) st.retryAt = 0;
    if (!st.registered && st.pending === undefined && st.retryAt <= now) {
      st.pending = $.tool
        .register(SPEC)
        .then((r) => {
          // Only a mcp__<plugin>__size-task name: a hook above answering anything else must not make this hook claim another tool.
          if (typeof r?.tool === "string" && r.tool.startsWith("mcp__") && r.tool.endsWith(`__${TOOL}`)) st.names.add(r.tool);
          st.registered = true;
          st.failures = 0;
        })
        .catch((err: unknown) => {
          const n = ++st.failures;
          st.retryAt = Date.now() + (n === 1 ? 0 : Math.min(MAX_RETRY_MS, RETRY_BASE_MS * 2 ** (n - 2)));
          if (st.logged) return;
          st.logged = true;
          void Promise.resolve($.ui.log(`registering ${TOOL} failed: ${err instanceof Error ? err.message : String(err)}`)).catch(() => undefined);
        })
        .finally(() => {
          st.pending = undefined;
        });
    }
    if (st.pending !== undefined) await within($, ms, st.pending, undefined);
  } catch {
    // best effort: the hook goes on
  }
}

/**
 * Asks jev-api's `request` tool the size question.
 *
 * @param $ - The engine.
 * @param state - The task text and subsystem lines.
 * @returns The answer's choice and probability, or undefined when jev-api is missing, failed, timed out or answered something else.
 */
async function askJev($: Engine, state: string): Promise<Pick | undefined> {
  try {
    const call = $.tool.call({ tool: JEV_REQUEST, state, questions: [QUESTION], timeout: JEV_TIMEOUT_S }).catch(() => undefined);
    const r = await within($, JEV_BUDGET_MS, call, undefined);
    const text = r === undefined ? undefined : textOf(r);
    return text === undefined ? undefined : readAnswer(text);
  } catch {
    // a refused clock or call: no jev-api answer, the model fallback goes on
    return undefined;
  }
}

/**
 * Asks a plain model the size question.
 *
 * @param $ - The engine.
 * @param state - The task text and subsystem lines.
 * @param signal - Aborts when the call is abandoned.
 * @returns The size, or undefined when the model did not answer with one.
 */
async function askModel($: Engine, state: string, signal: AbortSignal): Promise<Size | undefined> {
  try {
    const r = await $.model.complete({ model: FALLBACK_MODEL, system: MODEL_SYSTEM, prompt: modelPrompt(state), maxTokens: 16, timeoutMs: MODEL_TIMEOUT_MS }, { signal });
    return r.isAnswered ? readModelSize(r.text) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Registers the module's hooks.
 *
 * @param on - The engine's hook registrar.
 */
export function register(on: On): void {
  const st: RegState = { names: new Set([FULL]), registered: false, pending: undefined, logged: false, failures: 0, retryAt: 0 };
  on("session.start", async function onSessionStart($, e, next) {
    await ensureTool($, st, 5 * REGISTER_WAIT_MS);
    return next(e);
  });
  on("tool.call", async function onToolCall($, e, next) {
    if (!st.names.has(e.tool)) return next(e);
    // Answered on every path, a throw too: a registered tool that no hook answers fails.
    try {
      if (!st.registered) await ensureTool($, st, REGISTER_WAIT_MS);
      const state = parseInput(e);
      if (typeof state !== "string") return { deny: `${TOOL}: ${state.error}` };
      const abandoned = { deny: `${TOOL}: the call was abandoned` };
      if (next.signal.aborted) return abandoned;
      const jev = await askJev($, state);
      const jevText = jev && `${jev.size} (jev-api, probability ${jev.probability.toFixed(2)}`;
      if (jev && jev.probability >= MIN_PROBABILITY) return { result: `${jevText})` };
      if (next.signal.aborted) return abandoned;
      const model = await askModel($, state, next.signal);
      if (model) return { result: `${model} (model ${FALLBACK_MODEL}; ${jev ? `jev-api was unsure: ${jev.size} at probability ${jev.probability.toFixed(2)}` : "jev-api gave no answer"})` };
      if (jevText) return { result: `${jevText} below ${MIN_PROBABILITY}; the model call failed)` };
      return { deny: `${TOOL}: neither jev-api nor the model gave a size` };
    } catch (err) {
      return { deny: `${TOOL}: ${err instanceof Error ? err.message : String(err)}` };
    }
  });
}
