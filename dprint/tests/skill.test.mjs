// Static checks on the hand-written skill files and the generated manifest.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILL = readFileSync(
  path.join(ROOT, "plugin/skills/init-dprint/SKILL.md"),
  "utf8",
);

test("generated manifest equals plugin.json", () => {
  assert.deepEqual(
    JSON.parse(
      readFileSync(
        path.join(ROOT, "plugin/.claude-plugin/plugin.json"),
        "utf8",
      ),
    ),
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

test("SKILL.md runs the plugin scan via CLAUDE_SKILL_DIR and adds plugins only via config add", () => {
  assert.match(SKILL, /\$\{CLAUDE_SKILL_DIR\}\/scan-plugins\.mjs/);
  assert.match(SKILL, /scan-plugins\.reference\.md/);
  assert.match(SKILL, /config add/);
});

test("README documents the format_pre hook and its dprint lsp requirement", () => {
  const readme = readFileSync(path.join(ROOT, "plugin/README.md"), "utf8");
  assert.match(readme, /format_pre/);
  assert.match(readme, /dprint lsp/);
  const min = /^const MIN_VERSION = "(\d+\.\d+)/m.exec(
    readFileSync(
      path.join(ROOT, "src/skills/init-dprint/check-dprint.mts"),
      "utf8",
    ),
  )?.[1];
  assert.ok(min);
  assert.ok(readme.includes(`dprint >= ${min}`));
});

test("README documents the config gate, the 15 s toast module and all six config names; line 3 mirrors plugin.json", async () => {
  const readme = readFileSync(path.join(ROOT, "plugin/README.md"), "utf8");
  const { CONFIG_NAMES } = await import(
    "../plugin/skills/init-dprint/config-names.mjs"
  );
  assert.match(readme, /hooks\/notice\.mjs/);
  assert.match(readme, /15 s toast/);
  assert.match(readme, /only when the working directory or an ancestor has a dprint config/);
  for (const n of CONFIG_NAMES) assert.ok(readme.includes(`\`${n}\``), n);
  const manifest = JSON.parse(
    readFileSync(path.join(ROOT, "plugin.json"), "utf8"),
  );
  assert.equal(readme.split("\n")[2], manifest.description);
  assert.match(manifest.description, /shows a toast when it has none/);
});
