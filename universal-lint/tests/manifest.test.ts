// Wiring contract of the built plugin/ (what the scaffold/skill bats checks still mean in this repo; the layout
// allowlist, manifest generation and layout are guarded repo-wide by pnpm build and CI).
import assert from "node:assert/strict";
import { accessSync, constants, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "vitest";
import { HOOK, PLUGIN } from "./support/lint-hook.ts";

const json = (rel: string) => JSON.parse(readFileSync(path.join(PLUGIN, rel), "utf8"));

test("plugin.json has no userConfig (deliberate, see CLAUDE.md)", () => {
  assert.ok(!("userConfig" in json(".claude-plugin/plugin.json")));
});

test("PostToolUse hook is wired to lint-file.mjs as an asyncRewake command hook with timeout 90", () => {
  const h = json("hooks/hooks.json").hooks.PostToolUse[0];
  assert.equal(h.matcher, "Write|Edit");
  assert.equal(h.hooks[0].type, "command");
  assert.equal(h.hooks[0].command, "node");
  assert.deepEqual(h.hooks[0].args, ["${CLAUDE_PLUGIN_ROOT}/hooks/lint-file.mjs"]);
  assert.equal(h.hooks[0].timeout, 90);
  assert.equal(h.hooks[0].asyncRewake, true);
  assert.equal(h.hooks[0].async, undefined);
});

for (const ev of ["SessionStart", "CwdChanged"]) {
  test(`${ev} hook is wired to lint-file.mjs as a sync command hook with timeout 30 and no matcher`, () => {
    const h = json("hooks/hooks.json").hooks[ev][0];
    assert.equal(h.matcher, undefined);
    assert.equal(h.hooks[0].type, "command");
    assert.equal(h.hooks[0].command, "node");
    assert.deepEqual(h.hooks[0].args, ["${CLAUDE_PLUGIN_ROOT}/hooks/lint-file.mjs"]);
    assert.equal(h.hooks[0].timeout, 30);
    assert.equal(h.hooks[0].asyncRewake, undefined);
    assert.equal(h.hooks[0].async, undefined);
  });
}

test("FileChanged hook is wired to lint-file.mjs as an asyncRewake command hook with timeout 90 and no matcher", () => {
  const h = json("hooks/hooks.json").hooks.FileChanged[0];
  assert.equal(h.matcher, undefined);
  assert.equal(h.hooks[0].type, "command");
  assert.equal(h.hooks[0].command, "node");
  assert.deepEqual(h.hooks[0].args, ["${CLAUDE_PLUGIN_ROOT}/hooks/lint-file.mjs"]);
  assert.equal(h.hooks[0].timeout, 90);
  assert.equal(h.hooks[0].asyncRewake, true);
  assert.equal(h.hooks[0].async, undefined);
});

for (const ev of ["Stop", "SubagentStop"]) {
  test(`${ev} hook is wired to lint-file.mjs as a sync command hook with timeout 90 and no matcher (exit 2 must reach the stopping agent)`, () => {
    const h = json("hooks/hooks.json").hooks[ev][0];
    assert.equal(h.matcher, undefined);
    assert.equal(h.hooks[0].type, "command");
    assert.equal(h.hooks[0].command, "node");
    assert.deepEqual(h.hooks[0].args, ["${CLAUDE_PLUGIN_ROOT}/hooks/lint-file.mjs"]);
    assert.equal(h.hooks[0].timeout, 90);
    assert.equal(h.hooks[0].asyncRewake, undefined);
    assert.equal(h.hooks[0].async, undefined);
  });
}

test("lint-file.mjs is executable and has a node shebang (it is invoked directly)", () => {
  accessSync(HOOK, constants.X_OK);
  assert.equal(readFileSync(HOOK, "utf8").split("\n")[0], "#!/usr/bin/env node");
});

test("lint-file.mjs has no static node:crypto import (loaded lazily on first hash, F26)", () => {
  assert.doesNotMatch(readFileSync(HOOK, "utf8"), /\b(?:from|import)\s*["'](?:node:)?crypto["']/);
});

test("lint-file.mjs keeps the createRequire fallback next to getBuiltinModule (Node 18.14 floor, F26)", () => {
  const text = readFileSync(HOOK, "utf8");
  assert.ok(text.includes("getBuiltinModule"));
  assert.ok(text.includes("createRequire"));
});

test("README and plugin.json description say a user-level linter config also keeps the line-length rule on", () => {
  const readme = readFileSync(path.join(PLUGIN, "README.md"), "utf8");
  for (const place of ["~/.config/yamllint/config", "$YAMLLINT_CONFIG_FILE", "~/.markdownlintrc", "/etc/markdownlint"]) {
    assert.ok(readme.includes(place), place);
  }
  assert.match(json(".claude-plugin/plugin.json").description, /neither the project nor the user has a linter config/);
});

test("plugin README first ## heading is Install, with the install command and no ## Hooks section", () => {
  const readme = readFileSync(path.join(PLUGIN, "README.md"), "utf8");
  assert.equal(/^## .*/m.exec(readme)?.[0], "## Install");
  assert.ok(readme.includes("/plugin install universal-lint@kwitsch-plugins"));
  assert.doesNotMatch(readme, /^## Hooks/m);
});
