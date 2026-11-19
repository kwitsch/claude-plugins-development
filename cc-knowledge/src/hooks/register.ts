/**
 * Claude Code function-hooks module of cc-knowledge: runs a dispatch of the built-in `claude-code-guide` agent as
 * the plugin's `claude-code-expert`, which answers from the bundled references.
 *
 * @remarks
 * No engine type import (the engine typings are not in the repo): the used `on` member is typed structurally. The
 * pure reroute logic lives in this file (one small module, no helper files, so no `lib.mjs` bundle). Fail-open: the
 * hook has no `.catch`, so a throwing hook is skipped and the guide runs un-rerouted.
 *
 * @packageDocumentation
 */

/** The `subagent_type` an Agent call runs with when it asked for the built-in guide. */
const REROUTE_TARGET = "cc-knowledge:claude-code-expert";

/** An `Agent`/`Task` call as the hook sees it: the tool name plus its input fields. */
type AgentCall = { tool: string; subagent_type?: unknown } & Record<string, unknown>;

/** The rest of the hook chain: passes the (possibly rewritten) call on. */
type Next = (e: AgentCall) => Promise<unknown>;

/** The `on` registrar of the module: the one hooked event with its tool matcher. */
type On = (event: "tool.call", matcher: { tool: string[] }, hook: (_$: unknown, e: AgentCall, next: Next) => Promise<unknown>) => void;

/**
 * Normalizes a `subagent_type`: lowercase, runs of non-alphanumerics collapsed to `-`, trimmed.
 *
 * @param value - The raw value of the call.
 * @returns The normalized string; empty for a missing value.
 */
function normalize(value: unknown): string {
  // a non-string can never spell the guide, so it normalizes to ""
  return (typeof value === "string" ? value : "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * The `subagent_type` an Agent call should run with: the expert for any spelling of `claude-code-guide`, else the
 * value unchanged. Loop-safe: the target is not a guide.
 *
 * @param subagentType - The call's `subagent_type`.
 * @returns The target type or the unchanged value.
 */
function rerouteType(subagentType: unknown): unknown {
  return normalize(subagentType) === "claude-code-guide" ? REROUTE_TARGET : subagentType;
}

/**
 * Registers the module's hook.
 *
 * @param on - The engine's hook registrar.
 */
export function register(on: On): void {
  // Reroute a claude-code-guide dispatch to the cc-reference-grounded expert; every other call passes untouched.
  on("tool.call", { tool: ["Agent", "Task"] }, function reroute(_$, e, next) {
    const subagent_type = rerouteType(e.subagent_type);
    return next(subagent_type === e.subagent_type ? e : { ...e, subagent_type });
  });
}
