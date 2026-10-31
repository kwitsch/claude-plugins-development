// Static checks on the hand-written skill files and the generated manifest.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILL = readFileSync(
  path.join(ROOT, "plugin/skills/dprint/SKILL.md"),
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
  assert.match(SKILL, /^name: dprint$/m);
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
      path.join(ROOT, "src/skills/dprint/check-dprint.mts"),
      "utf8",
    ),
  )?.[1];
  assert.ok(min);
  assert.ok(readme.includes(`dprint >= ${min}`));
});

test("README documents the config gate, the 15 s toast module and all six config names; line 3 mirrors plugin.json", async () => {
  const readme = readFileSync(path.join(ROOT, "plugin/README.md"), "utf8");
  const { CONFIG_NAMES } = await import(
    "../plugin/skills/dprint/config-names.mjs"
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

test("SKILL.md frontmatter: argument-hint lists the three actions", () => {
  assert.match(SKILL, /^argument-hint: "\[init\|check\|fmt\] \[scope\]"$/m);
});

test("SKILL.md runs check/fmt via run-dprint, points to /dprint init and can create a config", () => {
  assert.match(SKILL, /\$\{CLAUDE_SKILL_DIR\}\/run-dprint\.mjs/);
  assert.match(SKILL, /run-dprint\.reference\.md/);
  assert.match(SKILL, /\/dprint init/);
  assert.match(SKILL, / init -y/);
});

test("SKILL.md uses the arguments placeholder exactly once and no indexed placeholders", () => {
  assert.equal(SKILL.split("$ARGUMENTS").length, 2);
  assert.doesNotMatch(SKILL, /\$[01]\b/);
});

test("README documents /dprint:dprint and mirrors the plugin.json description", () => {
  const readme = readFileSync(path.join(ROOT, "plugin/README.md"), "utf8");
  assert.match(readme, /\/dprint:dprint/);
  const { description } = JSON.parse(readFileSync(path.join(ROOT, "plugin.json"), "utf8"));
  assert.ok(readme.includes(description));
});

test("README documents the cwd scope, FileChanged formatting and the watch-list hook", () => {
  const readme = readFileSync(path.join(ROOT, "plugin/README.md"), "utf8");
  for (const s of [
    "file_written",
    "file_changed",
    "mcp/watch-paths.mjs",
    "dprint file-paths",
    "scratchpad_dir",
    "git status --porcelain",
    "5000",
    "and the file's real path is inside the working directory and not in the session scratchpad",
  ])
    assert.ok(readme.includes(s), s);
  const manifest = JSON.parse(
    readFileSync(path.join(ROOT, "plugin.json"), "utf8"),
  );
  assert.match(
    manifest.description,
    /formats every Write and Edit inside the working directory, and files changed there by other tools, with the project's dprint config via hooks/,
  );
});
