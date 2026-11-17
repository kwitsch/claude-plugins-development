// Tests for the built plugin/bin/session-start.mjs of rc-enhancement and the hooks.json that wires it and the Stop hook.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../plugin");
const hooksDir = path.join(pluginDir, "hooks");
const script = path.join(pluginDir, "bin/session-start.mjs");

test("answers a SessionStart JSON object whose additionalContext is the CRITICAL RULE with every required token, exit 0", () => {
  const r = spawnSync("node", [script], { input: "{}", encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
  assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
  for (const token of ["# CRITICAL RULE", "AskUserQuestion", "question mark", "Other", "Abort/Cancel"]) {
    assert.ok(out.hookSpecificOutput.additionalContext.includes(token), `missing: ${token}`);
  }
});

test("hooks.json: one matcher-less SessionStart and one matcher-less Stop command hook on the built scripts, no mods module", () => {
  const cfg = JSON.parse(readFileSync(path.join(hooksDir, "hooks.json"), "utf8")) as {
    modules?: string[];
    hooks: Record<string, { matcher?: string; hooks: { type: string; command: string; timeout: number }[] }[]>;
  };
  assert.equal(cfg.modules, undefined);
  assert.deepEqual(Object.keys(cfg.hooks).sort(), ["SessionStart", "Stop"]);
  for (const [event, name] of [["SessionStart", "session-start"], ["Stop", "stop"]] as const) {
    const groups = cfg.hooks[event] ?? [];
    assert.equal(groups.length, 1);
    assert.equal(groups[0]?.matcher, undefined);
    assert.equal(groups[0]?.hooks.length, 1);
    assert.equal(groups[0]?.hooks[0]?.type, "command");
    assert.equal(groups[0]?.hooks[0]?.command, `"\${CLAUDE_PLUGIN_ROOT}/bin/${name}.mjs"`);
    assert.ok((statSync(path.join(pluginDir, "bin", `${name}.mjs`)).mode & 0o111) !== 0, `${name}.mjs is not executable`);
  }
});
