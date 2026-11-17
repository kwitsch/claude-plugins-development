// Tests for the built plugin/hooks/session-start.mjs of rc-enhancement and the hooks.json that wires it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const hooksDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../plugin/hooks");

test("prints the CRITICAL RULE with every required token and exits 0", () => {
  const r = spawnSync("node", [path.join(hooksDir, "session-start.mjs")], { input: "{}", encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  for (const token of ["# CRITICAL RULE", "AskUserQuestion", "question mark", "Other", "Abort/Cancel"]) {
    assert.ok(r.stdout.includes(token), `missing: ${token}`);
  }
});

test("hooks.json: one matcher-less SessionStart command hook on the built script, plus the register module", () => {
  const cfg = JSON.parse(readFileSync(path.join(hooksDir, "hooks.json"), "utf8")) as {
    modules: string[];
    hooks: Record<string, { matcher?: string; hooks: { type: string; command: string; timeout: number }[] }[]>;
  };
  assert.deepEqual(cfg.modules, ["./register.mjs"]);
  assert.deepEqual(Object.keys(cfg.hooks), ["SessionStart"]);
  const [group] = cfg.hooks["SessionStart"] ?? [];
  assert.equal(cfg.hooks["SessionStart"]?.length, 1);
  assert.equal(group?.matcher, undefined);
  assert.equal(group?.hooks.length, 1);
  assert.equal(group?.hooks[0]?.type, "command");
  assert.equal(group?.hooks[0]?.command, "\"${CLAUDE_PLUGIN_ROOT}/hooks/session-start.mjs\"");
  assert.ok((statSync(path.join(hooksDir, "session-start.mjs")).mode & 0o111) !== 0, "session-start.mjs is not executable");
});
