// Wiring contract of the built plugin/ (what the scaffold/skill bats checks still mean in this repo; the layout
// allowlist, manifest generation and layout are guarded repo-wide by pnpm build and CI).
import assert from "node:assert/strict";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "vitest";
import { MOD, PLUGIN, SERVER, WATCH } from "./support/lint-hook.ts";

const json = (rel: string) => JSON.parse(readFileSync(path.join(PLUGIN, rel), "utf8"));
const hooks = () => json("hooks/hooks.json");
const LINT = "plugin:universal-lint:lint";
const STOP_INPUT = { hook_event_name: "${hook_event_name}", cwd: "${cwd}", session_id: "${session_id}", agent_id: "${agent_id}", scratchpad_dir: "${scratchpad_dir}", stop_hook_active: "${stop_hook_active}" };

test("plugin.json has no userConfig (deliberate, see CLAUDE.md)", () => assert.ok(!("userConfig" in json(".claude-plugin/plugin.json"))));

test("hooks.json lists the mod and exactly six events, none of them a tool hook", () => {
  assert.deepEqual(hooks().modules, ["./register.js"]);
  assert.deepEqual(Object.keys(hooks().hooks).sort(), ["CwdChanged", "FileChanged", "SessionStart", "Stop", "SubagentStop", "UserPromptSubmit"]);
});

for (const ev of ["SessionStart", "CwdChanged"]) {
  test(`${ev}: exactly one command hook, watch-paths.mjs, timeout 30`, () => {
    assert.deepEqual(hooks().hooks[ev], [{ hooks: [{ type: "command", command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/hooks/watch-paths.mjs"], timeout: 30 }] }]);
  });
}

for (
  const [ev, tool, timeout, input] of [
    ["UserPromptSubmit", "prompt_submitted", 10, { cwd: "${cwd}", session_id: "${session_id}", scratchpad_dir: "${scratchpad_dir}" }],
    ["FileChanged", "file_changed", 100, { cwd: "${cwd}", session_id: "${session_id}", scratchpad_dir: "${scratchpad_dir}", file_path: "${file_path}", event: "${event}" }],
    ["Stop", "stop", 100, STOP_INPUT],
    ["SubagentStop", "stop", 100, STOP_INPUT],
  ] as const
) {
  test(`${ev}: one mcp_tool hook, tool ${tool}, timeout ${timeout}, exact input`, () => {
    assert.deepEqual(hooks().hooks[ev], [{ hooks: [{ type: "mcp_tool", server: LINT, tool, timeout, input }] }]);
  });
}

test(".mcp.json starts the lint server", () => assert.deepEqual(Object.keys(json(".mcp.json").mcpServers), ["lint"]));

for (const [name, file] of [["watch-paths.mjs", WATCH], ["mcp/server.mjs", SERVER]] as const) {
  test(`${name} is executable and has a node shebang`, () => {
    accessSync(file, constants.X_OK);
    assert.equal(readFileSync(file, "utf8").split("\n")[0], "#!/usr/bin/env node");
  });
}

test("register.js exists, lint-file.mjs does not", () => {
  assert.ok(existsSync(MOD));
  assert.equal(existsSync(path.join(PLUGIN, "hooks/lint-file.mjs")), false);
});

test("watch-paths.mjs has no static node:crypto import (loaded lazily on first hash, F26)", () => assert.doesNotMatch(readFileSync(WATCH, "utf8"), /\b(?:from|import)\s*["'](?:node:)?crypto["']/));

// watch-paths.mjs never hashes, so the bundler drops the lazy loader there; server.mjs is the output that hashes.
test("mcp/server.mjs keeps the createRequire fallback next to getBuiltinModule (Node 18.14 floor, F26)", () => {
  const text = readFileSync(SERVER, "utf8");
  assert.ok(text.includes("getBuiltinModule") && text.includes("createRequire"));
});

test("the description is one sentence of at most 200 characters; the README carries the linter-config sentence and the four config places", () => {
  const d = json(".claude-plugin/plugin.json").description as string;
  assert.equal(d, "Runs each language's standard linter, read-only, on the files Claude writes or that change in the project, and hands the findings to Claude to fix.");
  assert.ok(d.length <= 200);
  const readme = readFileSync(path.join(PLUGIN, "README.md"), "utf8");
  for (const place of ["~/.config/yamllint/config", "$YAMLLINT_CONFIG_FILE", "~/.markdownlintrc", "/etc/markdownlint"]) assert.ok(readme.includes(place), place);
  assert.match(readme, /neither the project nor the user has a linter config/);
  assert.match(readme, /two internal tools/);
});

test("plugin README first ## heading is Install, with the install command and no ## Hooks section", () => {
  const readme = readFileSync(path.join(PLUGIN, "README.md"), "utf8");
  assert.equal(/^## .*/m.exec(readme)?.[0], "## Install");
  assert.ok(readme.includes("/plugin install universal-lint@kwitsch-plugins"));
  assert.doesNotMatch(readme, /^## Hooks/m);
});

test("server.mjs holds no blocking wait", () => assert.doesNotMatch(readFileSync(SERVER, "utf8"), /Atomics\.wait/));
