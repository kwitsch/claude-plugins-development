// Static checks on the hand-written skill files and the generated manifest.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILL = readFileSync(path.join(ROOT, "plugin/skills/init-dprint/SKILL.md"), "utf8");

test("generated manifest equals plugin.json", () => {
  assert.deepEqual(
    JSON.parse(readFileSync(path.join(ROOT, "plugin/.claude-plugin/plugin.json"), "utf8")),
    JSON.parse(readFileSync(path.join(ROOT, "plugin.json"), "utf8")),
  );
});

test("SKILL.md frontmatter: name, model-invocable, allowed-tools without bare Bash", () => {
  assert.match(SKILL, /^name: init-dprint$/m);
  assert.doesNotMatch(SKILL, /^disable-model-invocation:\s*true/m);
  const tools = /^allowed-tools:\s*(.+)$/m.exec(SKILL)?.[1] ?? "";
  assert.match(tools, /AskUserQuestion/);
  assert.match(tools, /Bash\(node:\*\)/);
  assert.doesNotMatch(tools, /(^|[\s,])Bash($|[\s,])/);
});

test("SKILL.md invokes the script via CLAUDE_SKILL_DIR, never defines MIN_VERSION, no !` injection", () => {
  assert.match(SKILL, /\$\{CLAUDE_SKILL_DIR\}\/check-dprint\.mjs/);
  assert.match(SKILL, /check-dprint\.reference\.md/);
  assert.doesNotMatch(SKILL, /MIN_VERSION\s*=/);
  assert.doesNotMatch(SKILL, /!`/);
  assert.ok(SKILL.split("\n").length < 500);
});
