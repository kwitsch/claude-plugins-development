/**
 * Claude Code function-hooks module of jev-api: registers the TypeSafe Jev System One question types `noul`,
 * `choice` and `score` as tools, plus `batch` for several questions about one text, and answers each call with one
 * System One request.
 *
 * @remarks
 * EARLY ACCESS API. No engine type import (the engine typings are not in the repo): the used `$` members and
 * events are typed structurally in `types.mts`. `development/scripts/build-plugin.mts` keeps `hooks/*.mjs` unmangled and
 * uncompressed, since the engine's static check wants `$`/`on` spelled as such and no `$.<noun>` passed as a bare
 * value; every hook is a named function literal. Only this file is listed in `hooks.json`; it imports its siblings
 * (`types`, `util`, `tools`, `input`, `haiku`, `size`, `jev`, `registry`), and HTTP goes through `$.http.fetch`.
 *
 * @packageDocumentation
 */

import { askHaiku, HAIKU_MAX_CHARS } from "./haiku.mjs";
import { parseInput } from "./input.mjs";
import { answerJev } from "./jev.mjs";
import { ensureTools, REGISTER_WAIT_MS } from "./registry.mjs";
import type { RegState } from "./registry.mjs";
import { cutState, DEFAULT_CONTEXT_TOKENS, DEFAULT_DENSITY, loadKnowledge } from "./size.mjs";
import type { Knowledge } from "./size.mjs";
import { TOOL_PREFIX } from "./tools.mjs";
import { DEFAULT_OVERFLOW, TOOLS } from "./types.mjs";
import type { On, Options, ToolName } from "./types.mjs";
import { DEFAULT_TIMEOUT_S, fail, isOverflow, message, seconds } from "./util.mjs";

/**
 * Registers the module's hooks.
 *
 * @param on - The engine's hook registrar.
 * @param options - The plugin's `userConfig` values; `timeout` is the request timeout in seconds for calls that give
 * none.
 */
export function register(on: On, options?: Options): void {
  // A call's own `timeout` wins; an invalid one falls back like a missing one.
  const fallbackS = seconds(options?.["timeout"]) ?? DEFAULT_TIMEOUT_S;
  // A call's own `overflow` wins; an invalid option falls back to the default like an invalid timeout does.
  const optionOverflow = options?.["overflow"];
  const defaultOverflow = isOverflow(optionOverflow) ? optionOverflow : DEFAULT_OVERFLOW;
  // Full tool name -> tool: the default names (a call can reach an instance that saw no session.start), plus what the engine returned.
  const names = new Map<string, ToolName>(TOOLS.map((t) => [TOOL_PREFIX + t, t]));
  // `$` reaches a module only inside its hooks, so the tools register in the first hook that runs (session.start, or an earlier tool call).
  // The engine accepts `$` only as an argument to a top-level function, hence `ensureTools` and the state object.
  // A tool whose registration failed stays in `missing`: the next hook tries it again (after a growing delay), no timers.
  const st: RegState = { names, missing: new Set<ToolName>(TOOLS), pending: new Map(), retryAt: new Map(), failures: new Map(), stuck: new Set() };
  // What this instance learned about System One's size limits; the density comes back from the store in the first call that needs it.
  const know: Knowledge = { density: DEFAULT_DENSITY, persisted: DEFAULT_DENSITY, samples: 0, nctx: DEFAULT_CONTEXT_TOKENS, loaded: undefined };
  on("session.start", async function onSessionStart($, e, next) {
    try {
      if (st.missing.size > 0) await ensureTools($, st, 5 * REGISTER_WAIT_MS);
    } catch {
      // best effort (a hook above refusing $.clock): the session.start chain goes on
    }
    return next(e);
  });
  on("tool.call", async function onToolCall($, e, next) {
    const type = names.get(e.tool);
    if (type === undefined) return next(e);
    // Answered on every path, a throw too (a hook above refusing $.env.get): a registered tool that no hook answers fails.
    try {
      // best effort and bounded: a failed or hanging registration must not hold the answer
      if (st.missing.size > 0) {
        try {
          await ensureTools($, st, REGISTER_WAIT_MS);
        } catch {
          // best effort (a hook above refusing $.clock): the call is answered anyway
        }
      }
      // Validation needs no env: an invalid call answers before any env read.
      const input = parseInput(type, e);
      if (typeof input === "string") return fail(type, input);
      // Literal names: the engine's static check only accepts a literal first argument to $.env.get.
      const [key, base, jevUrl, model] = (await Promise.all([$.env.get("TYPESAFE_API_KEY"), $.env.get("TYPESAFE_BASE_URL"), $.env.get("JEV_URL"), $.env.get("TYPESAFE_DEFAULT_MODEL")])).map((v) => v?.trim() || undefined);
      // F05: an abandoned call sends nothing
      if (next.signal.aborted) return fail(type, "the call was abandoned");
      // No Jev access configured: Haiku stands in. A configured Jev that fails stays an error.
      // A whole number of milliseconds, at least 1: $.model.complete refuses anything else (2.01 s * 1000 is 2009.9999999999998).
      const timeoutMs = Math.max(1, Math.round((seconds(e["timeout"]) ?? fallbackS) * 1000));
      if (!key && !base && !jevUrl) return await askHaiku($, type, cutState(input.state, HAIKU_MAX_CHARS), input.questions, timeoutMs, next.signal);
      await loadKnowledge($, know);
      if (next.signal.aborted) return fail(type, "the call was abandoned");
      return await answerJev($, type, input, input.overflow ?? defaultOverflow, { key, base, jevUrl, model }, timeoutMs, next.signal, know);
    } catch (err) {
      return fail(type, message(err));
    }
  });
}
