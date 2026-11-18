/**
 * Claude Code function-hooks module of jev-api: registers the TypeSafe Jev System One tool `request` (one or more
 * noul, choice and score questions about one text) and answers each call with one System One request.
 *
 * @remarks
 * EARLY ACCESS API. No engine type import (the engine typings are not in the repo): the used `$` members and
 * events are typed structurally in `types.mts`. Only this file is listed in `hooks.json`, and
 * `development/scripts/build-plugin.ts` (`pluginBuild.bundleHooksLib`) keeps only `register.mjs` unmangled,
 * uncompressed and with its whitespace, since the engine's static check wants `$`/`on` spelled as such and no
 * `$.<noun>` passed as a bare value; every hook is a named function literal. Its siblings (`types`, `util`, `tools`,
 * `input`, `haiku`, `size`, `jev`, `transport`, `registry`) are bundled into one `./lib.mjs` (compressed and stripped of
 * whitespace, not mangled) that `register.mjs` imports everything from. The System One request goes through the
 * plugin's own MCP server (`transport.mts`), which enforces the timeout and cancels; `$.http.fetch` is the fallback.
 * The third hook, `tool.check`, keeps the model off that server's tools.
 *
 * @packageDocumentation
 */

import { askHaiku, HAIKU_MAX_CHARS } from "./haiku.js";
import { parseInput } from "./input.js";
import { answerJev } from "./jev.js";
import { ensureTools, REGISTER_WAIT_MS } from "./registry.js";
import type { RegState } from "./registry.js";
import { cutState, DEFAULT_CONTEXT_TOKENS, DEFAULT_DENSITY, loadKnowledge } from "./size.js";
import type { Knowledge } from "./size.js";
import { TOOL_PREFIX } from "./tools.js";
import { newLink, PLUGIN, SERVER_TOOL_PREFIX } from "./transport.js";
import { DEFAULT_OVERFLOW, TOOL } from "./types.js";
import type { On, Options } from "./types.js";
import { DEFAULT_TIMEOUT_S, fail, isOverflow, message, seconds, untilAbort } from "./util.js";

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
  // The full tool names answered: the default name (a call can reach an instance that saw no session.start), plus what the engine returned.
  const names = new Set<string>([TOOL_PREFIX + TOOL]);
  // `$` reaches a module only inside its hooks, so the tool registers in the first hook that runs (session.start, or an earlier tool call).
  // The engine accepts `$` only as an argument to a top-level function, hence `ensureTools` and the state object.
  // A tool whose registration failed stays unregistered: the next hook tries it again (after a growing delay), no timers.
  const st: RegState = { names, registered: false, pending: undefined, gen: 0, retryAt: 0, failures: 0, stuck: false };
  // What this instance learned about System One's size limits; the density comes back from the store in the first call that needs it.
  const know: Knowledge = { density: DEFAULT_DENSITY, persisted: DEFAULT_DENSITY, samples: 0, nctx: DEFAULT_CONTEXT_TOKENS, loaded: undefined };
  // The HTTP transport: the plugin's MCP server while it is available, `$.http.fetch` while it is not (see transport.mts).
  const link = newLink();
  on("session.start", async function onSessionStart($, e, next) {
    try {
      // Binding the session is what earlier refusals were about: a new generation makes every attempt begun before it stale
      // (it settles without a failure count, back-off or log, and ensureTools starts a fresh one), and the back-off, failure
      // count (the once-only log stays for the first real failure after the bind) and stuck mark go.
      st.gen++;
      st.retryAt = 0;
      st.failures = 0;
      st.stuck = false;
      if (!st.registered) await ensureTools($, st, 5 * REGISTER_WAIT_MS);
    } catch {
      // best effort (a hook above refusing $.clock): the session.start chain goes on
    }
    return next(e);
  });
  on("tool.call", async function onToolCall($, e, next) {
    if (!names.has(e.tool)) return next(e);
    // Answered on every path, a throw too (a hook above refusing $.env.get): a registered tool that no hook answers fails.
    try {
      // best effort and bounded: a failed or hanging registration must not hold the answer
      if (!st.registered) {
        try {
          await untilAbort(ensureTools($, st, REGISTER_WAIT_MS), next.signal);
        } catch {
          // best effort (a hook above refusing $.clock): the call is answered anyway
        }
      }
      // Validation needs no env: an invalid call answers before any env read.
      const input = parseInput(e);
      if (typeof input === "string") return fail(input);
      // Literal names: the engine's static check only accepts a literal first argument to $.env.get.
      const [key, base, jevUrl, model] = (await Promise.all([$.env.get("TYPESAFE_API_KEY"), $.env.get("TYPESAFE_BASE_URL"), $.env.get("JEV_URL"), $.env.get("TYPESAFE_DEFAULT_MODEL")])).map((v) => v?.trim() || undefined);
      // F05: an abandoned call sends nothing
      if (next.signal.aborted) return fail("the call was abandoned");
      // No Jev access configured: Haiku stands in, and for a configured Jev that answers with an HTTP error (4xx, 5xx) too, with the time left of the timeout (jev.mts).
      // A whole number of milliseconds, at least 1: $.model.complete refuses anything else (2.01 s * 1000 is 2009.9999999999998).
      const timeoutMs = Math.max(1, Math.round((seconds(e["timeout"]) ?? fallbackS) * 1000));
      if (!key && !base && !jevUrl) return await askHaiku($, cutState(input.state, HAIKU_MAX_CHARS), input.questions, timeoutMs, next.signal);
      await untilAbort(loadKnowledge($, know), next.signal);
      if (next.signal.aborted) return fail("the call was abandoned");
      return await answerJev($, input, input.overflow ?? defaultOverflow, { key, base, jevUrl, model }, timeoutMs, next.signal, know, link);
    } catch (err) {
      return fail(message(err));
    }
  });
  // The model must not use the transport server's tools (a tool the mod can call cannot be hidden from the model: `$.mcp.call`
  // does not reach a tool with `_meta.ui.visibility` without `model`). The mod's own calls carry this plugin as origin.
  on("tool.check", async function onToolCheck(_$, e, next) {
    if (!e.tool.startsWith(SERVER_TOOL_PREFIX)) return next(e);
    if (next.origin?.plugin === PLUGIN) return { decision: "allow", reason: `${PLUGIN}'s own HTTP transport` };
    return { decision: "deny", reason: `this tool is the internal HTTP transport of the ${PLUGIN} plugin; use ${TOOL_PREFIX + TOOL}` };
  });
}
