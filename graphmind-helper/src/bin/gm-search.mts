#!/usr/bin/env node
// PreToolUse hook: the once-per-session nudge of `graphmind setup`'s graphmind-search.sh towards graphmind instead of grep/find/Explore.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { emit, findGraphmind, readInput, registered, setupHooksPresent, stateDir, str } from "./common.mjs";

/** A search command starts a command line segment: at the start, or after `&&`, `||` or `;` (not after a pipe, which filters output). */
const SEG = String.raw`(^|&&|\|\||;)\s*(rtk\s+)?`;

/**
 * Whether this tool call looks like a code search graphmind should answer.
 *
 * @param input - The hook payload.
 * @returns True to nudge.
 */
function shouldNudge(input: Record<string, unknown>): boolean {
  const tool = str(input.tool_name) || str(input.toolName);
  const ti = (input.tool_input ?? {}) as Record<string, unknown>;
  if (tool === "Grep" || tool === "Glob") return true;
  if (tool === "Bash") {
    const cmd = str(ti.command);
    if (new RegExp(`${SEG}graphmind\\b`).test(cmd)) return false;
    return new RegExp(`${SEG}(grep|egrep|rg|ag|ugrep|find|fd|bfs)\\b`).test(cmd);
  }
  if (tool === "Agent") {
    if (ti.subagent_type === "Explore") return true;
    return /search|find|explore|locate|where is|which file/i.test(str(ti.prompt));
  }
  return false;
}

/** Prints the nudge once per session. */
function main(): void {
  const input = readInput();
  if (!shouldNudge(input)) return;
  const ti = (input.tool_input ?? {}) as Record<string, unknown>;
  const check = `${str(ti.command)} ${str(ti.description)}`;
  // Exhaustive searches: grep is legitimately better.
  if (/all (usages|occurrences|references|instances)|find all|list all|exhaustive/i.test(check)) return;
  if (/\s-[a-zA-Z]*c|\|\s*wc\s|\|\s*sort\s|\|\s*uniq\s/.test(check)) return;
  const dir = stateDir(input.session_id);
  if (existsSync(join(dir, "nudged"))) return;
  const bin = findGraphmind();
  const active = bin !== undefined && !setupHooksPresent() && registered(bin);
  // Marked in every case: a project that is not indexed (or already wired by setup) would otherwise pay a `which` spawn on each matching call.
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "nudged"), "");
  if (!active) return;
  emit("PreToolUse", "⚡ This project is graphmind-indexed. Use /gm <query> for code exploration (symbols, callers, deps, outlines). Grep only for string literals/config values.");
}

main();
