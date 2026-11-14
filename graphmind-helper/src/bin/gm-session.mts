#!/usr/bin/env node
// SessionStart hook: the project briefing of `graphmind setup`'s graphmind-session.sh (priority and recent memory, map, status).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { emit, entryId, findGraphmind, listing, MAX_CHARS, readInput, registered, run, setupHooksPresent, stateDir } from "./common.mjs";

const DAY_MS = 86_400_000;

/**
 * Drops the state of sessions idle for more than two days, then empties and creates this session's directory.
 *
 * @param dir - This session's state directory.
 */
function resetState(dir: string): void {
  const root = join(homedir(), ".graphmind", "hook-state");
  try {
    for (const d of readdirSync(root)) {
      const p = join(root, d);
      for (const f of readdirSync(p)) {
        const fp = join(p, f);
        if (Date.now() - statSync(fp).mtimeMs > 2 * DAY_MS) rmSync(fp, { force: true });
      }
      if (readdirSync(p).length === 0) rmSync(p, { recursive: true, force: true });
    }
  } catch { /* no state yet */ }
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

/**
 * Starts the daily memory upkeep in the background, once per day.
 *
 * @param bin - The binary.
 */
function consolidateDaily(bin: string): void {
  const stamp = join(homedir(), ".graphmind", ".last-consolidate");
  try {
    if (existsSync(stamp) && Date.now() - statSync(stamp).mtimeMs < DAY_MS) return;
    mkdirSync(join(homedir(), ".graphmind"), { recursive: true });
    writeFileSync(stamp, "");
    utimesSync(stamp, new Date(), new Date());
    spawn(bin, ["memory", "consolidate"], { detached: true, stdio: "ignore" }).unref();
  } catch { /* upkeep is optional */ }
}

/** Builds the briefing and prints it. */
function main(): void {
  const bin = findGraphmind();
  if (!bin || setupHooksPresent()) return;
  const input = readInput();
  if (!registered(bin)) return;
  const dir = stateDir(input.session_id);
  resetState(dir);
  consolidateDaily(bin);

  const head = (out: string, n: number) => out.split("\n").slice(0, n).join("\n");
  const status = head(run(bin, ["status"]).stdout, 10).trimEnd();
  const map = head(run(bin, ["map"]).stdout, 20).trimEnd();
  const priority = listing(run(bin, ["memory", "list", "--priority", "--limit", "20", "--max-chars", "250"]).stdout);
  const recent = listing(run(bin, ["memory", "list", "--limit", "10", "--max-chars", "200"]).stdout).filter((l) => !l.includes("★")).slice(0, 5);

  let msg = `[graphmind] Project indexed and ready. Use MCP tools (gm_search, gm_fn, gm_deps, gm_map, gm_outline, gm_query) for code exploration.\n\nProject status:\n${status}\n\nStructure:\n${map}`;
  if (priority.length) msg += `\n\n★ Priority context (always active):\n${priority.join("\n")}`;
  if (recent.length) msg += `\n\nRecent memories:\n${recent.join("\n")}`;
  msg += "\n\nAuto-memory is ON: save decisions/patterns/conventions via gm_memory_add. Use --priority for always-injected facts. Recall via gm_memory_search.";
  if (msg.length > MAX_CHARS) msg = `${msg.slice(0, MAX_CHARS)}\n[graphmind: cut to fit the hook output limit]`;

  // Priority entries the session sees whole: the prompt hook adds the others later.
  const whole = new Set(msg.split("\n"));
  const ids = priority.filter((l) => whole.has(l)).map(entryId).filter((i): i is string => i !== undefined);
  writeFileSync(join(dir, "priority-ids"), ids.map((i) => `${i}\n`).join(""));
  emit("SessionStart", msg);
}

main();
