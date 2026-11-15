/**
 * Phase 3: when Claude starts a general-purpose subagent, Jev may pick a more specialised agent type. An explicit
 * choice by Claude is kept without asking Jev. Pure: the `agent.offer` and `tool.call {tool: "Agent"}` hooks
 * live in `register.mts`.
 *
 * @packageDocumentation
 */

/** Agent types that mean "no specific type": Jev may switch these. */
export const GENERAL = new Set(["", "general-purpose", "claude"]);
/** The probability from which Jev switches the type. */
export const SWITCH_AT = 0.85;
