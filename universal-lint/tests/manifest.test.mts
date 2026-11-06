// Wiring contract of the built plugin/ (what the scaffold/skill bats checks still mean in this repo; the layout
// allowlist, manifest generation and freshness are guarded repo-wide by pnpm build and CI).
import assert from "node:assert/strict";
import { accessSync, constants, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "vitest";
import { HOOK, PLUGIN } from "./support/lint-hook.mts";

const json = (rel: string) => JSON.parse(readFileSync(path.join(PLUGIN, rel), "utf8"));

test("plugin.json has the name and a version and no userConfig (deliberate, see CLAUDE.md)", () => {
  const m = json(".claude-plugin/plugin.json");
  assert.equal(m.name, "universal-lint");
  assert.equal(typeof m.version, "string");
  assert.ok(!("userConfig" in m));
});

test("PostToolUse hook is wired to lint-file.mjs as an asyncRewake command hook with timeout 95", () => {
  const h = json("hooks/hooks.json").hooks.PostToolUse[0];
  assert.equal(h.matcher, "Write|Edit");
  assert.equal(h.hooks[0].type, "command");
  assert.equal(h.hooks[0].command, "\"${CLAUDE_PLUGIN_ROOT}/hooks/lint-file.mjs\"");
  assert.equal(h.hooks[0].timeout, 95);
  assert.equal(h.hooks[0].asyncRewake, true);
  assert.equal(h.hooks[0].async, undefined);
});

test("lint-file.mjs is executable and has a node shebang (it is invoked directly)", () => {
  accessSync(HOOK, constants.X_OK);
  assert.equal(readFileSync(HOOK, "utf8").split("\n")[0], "#!/usr/bin/env node");
});

test("plugin README first ## heading is Install, with the install command and no ## Hooks section", () => {
  const readme = readFileSync(path.join(PLUGIN, "README.md"), "utf8");
  assert.equal(/^## .*/m.exec(readme)?.[0], "## Install");
  assert.ok(readme.includes("/plugin install universal-lint@kwitsch-plugins"));
  assert.doesNotMatch(readme, /^## Hooks/m);
});
