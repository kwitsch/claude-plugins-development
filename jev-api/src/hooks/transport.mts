/**
 * How the System One request leaves the mod: today only through `$.http.fetch` (`fetchViaEngine`), the transport that
 * stays as the fallback once the MCP server transport exists.
 *
 * @packageDocumentation
 */

import type { DoFetch } from "../shared/http.mjs";
import type { Engine } from "./types.mjs";

/**
 * An error with the given name, the way the HTTP core tells its two caller-set ends from any other failure.
 *
 * @param name - `TimeoutError` or `AbortError`.
 * @param message - The text for the model.
 * @returns The error.
 */
function named(name: "TimeoutError" | "AbortError", message: string): Error {
  return Object.assign(new Error(message), { name });
}

/**
 * The HTTP call through the engine's `$.http.fetch`: it races the request against the timeout and the abandonment of
 * the dispatch, because the engine's fetch has no signal and no timeout option (a timed-out or abandoned request runs
 * on until it settles or hits the engine's 30 s cap).
 *
 * @param $ - The engine.
 * @param timeoutMs - How long the request may take before it ends as a `TimeoutError`.
 * @param signal - Aborts when the call is abandoned: the request then ends as an `AbortError` at once.
 * @returns The `doFetch` for `sendRequest`.
 */
export function fetchViaEngine($: Engine, timeoutMs: number, signal: AbortSignal): DoFetch {
  return async (url, init) => {
    let timer: { cancel(): void } | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const request = $.http.fetch(url, init);
      request.catch(() => undefined); // a late rejection after the timeout or an abort won must not go unhandled
      // The engine does not stop a hook's request when its dispatch is abandoned: answer at once instead of lingering.
      const stop = new Promise<"timeout" | "aborted">((resolve) => {
        timer = $.clock.after(timeoutMs, () => resolve("timeout"));
        if (signal.aborted) resolve("aborted");
        else {
          onAbort = () => resolve("aborted");
          signal.addEventListener("abort", onAbort, { once: true });
        }
      });
      const res = await Promise.race([request, stop]);
      if (res === "timeout") throw named("TimeoutError", `timeout after ${timeoutMs}ms`);
      if (res === "aborted") throw named("AbortError", "the call was abandoned");
      return { status: res.status, text: res.text };
    } finally {
      timer?.cancel();
      if (onAbort) signal.removeEventListener("abort", onAbort); // a signal shared by many calls must not collect listeners
    }
  };
}
