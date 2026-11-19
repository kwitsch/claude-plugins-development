// What the shipped plugin's manifests, hook wiring and user-facing texts must hold. The `hooks.json` pins are
// regression pins: see `.claude/rules/hooks-and-server.md`.
import { pluginManifest } from "@scripts/plugin-manifest.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "vitest";
import { PLUGIN, SERVER } from "./support/mcp.ts";

const read = (...rel: string[]): string => readFileSync(path.join(PLUGIN, ...rel), "utf8");
const pkg = JSON.parse(read("..", "package.json")) as { version: string; description: string; scripts: Record<string, string>; devDependencies: Record<string, string>; pluginBuild: { assets: string[] } };
const manifest = JSON.parse(read(".claude-plugin", "plugin.json")) as Record<string, unknown>;
const hooks = JSON.parse(read("hooks", "hooks.json")) as { description: string; hooks: Record<string, { matcher: string; hooks: Record<string, unknown>[] }[]> };
const readme = read("README.md");
/** The plugin's own built modules (the vendored bundle is third-party code). */
const OWN_MODULES = [...readdirSync(path.join(PLUGIN, "mcp")).filter((f) => f.endsWith(".mjs")).map((f) => path.join("mcp", f)), "skills/universal-format/format-files.mjs"];

test("plugin.json is exactly what package.json generates, with no userConfig (deliberate: the hook is the plugin)", () => {
  assert.deepEqual(manifest, JSON.parse(JSON.stringify(pluginManifest(pkg as unknown as Record<string, unknown>))));
  assert.equal("userConfig" in manifest, false);
});

test("the description is one short sentence that names no implementation detail", () => {
  assert.equal(manifest.description, pkg.description);
  assert.ok(pkg.description.length <= 200, `${pkg.description.length} characters`);
  assert.doesNotMatch(pkg.description, /managed|npx|hook|MCP|bundle/i);
});

test("PreToolUse hook -> format_pre mcp_tool, matcher Write|Edit, timeout 60, not async", () => {
  const entry = hooks.hooks.PreToolUse[0];
  assert.equal(entry.matcher, "Write|Edit");
  const { input: _input, ...hook } = entry.hooks[0];
  assert.deepEqual(hook, { type: "mcp_tool", server: "plugin:universal-format:universal-format-hooks", tool: "format_pre", timeout: 60 });
});

test("hooks.json declares exactly one event, PreToolUse, with exactly one hook (no PostToolUse, no CwdChanged)", () => {
  assert.deepEqual(Object.keys(hooks.hooks), ["PreToolUse"]);
  assert.equal(hooks.hooks.PreToolUse.length, 1);
  assert.equal(hooks.hooks.PreToolUse[0].hooks.length, 1);
});

// Without `input` Claude Code delivers an EMPTY arguments object to the tool, not the hook JSON: the handler would
// silently format nothing while the hook still reports success.
test("format_pre's explicit input reconstructs exactly cwd, scratchpad_dir, tool_name and tool_input.file_path/content/old_string/new_string/replace_all", () => {
  assert.deepEqual(hooks.hooks.PreToolUse[0].hooks[0].input, {
    cwd: "${cwd}",
    scratchpad_dir: "${scratchpad_dir}",
    tool_name: "${tool_name}",
    tool_input: {
      file_path: "${tool_input.file_path}",
      content: "${tool_input.content}",
      old_string: "${tool_input.old_string}",
      new_string: "${tool_input.new_string}",
      replace_all: "${tool_input.replace_all}",
    },
  });
});

test(".mcp.json starts universal-format-hooks with node and the server module, without an env block", () => {
  assert.deepEqual(JSON.parse(read(".mcp.json")), { mcpServers: { "universal-format-hooks": { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/mcp/server.mjs"] } } });
});

test("mcp/server.mjs and the skill driver are executable node scripts that parse; the wasm files are not executable", () => {
  for (const f of [SERVER, path.join(PLUGIN, "skills/universal-format/format-files.mjs")]) {
    assert.ok(readFileSync(f, "utf8").startsWith("#!/usr/bin/env node\n"), f);
    assert.ok(statSync(f).mode & 0o100, `${f} must be executable`);
    assert.equal(spawnSync(process.execPath, ["--check", f]).status, 0, f);
  }
  for (const f of pkg.pluginBuild.assets) assert.equal(statSync(path.join(PLUGIN, f)).mode & 0o111, 0, `${f} must not be executable`);
});

test("hooks/ holds only hooks.json; no launcher script ships", () => {
  assert.deepEqual(readdirSync(path.join(PLUGIN, "hooks")), ["hooks.json"]);
  assert.deepEqual(readdirSync(PLUGIN).sort(), [".claude-plugin", ".mcp.json", "README.md", "hooks", "mcp", "shared", "skills"]);
});

test("the build runs the standard build first, then the vendor step (the standard build removes the chunks)", () => {
  assert.equal(pkg.scripts.build, "node ../development/scripts/build-plugin.ts && node scripts/vendor.mts");
});

test("prettier, its three plugins and sh-syntax are pinned exactly (no range prefix)", () => {
  for (const name of ["prettier", "prettier-plugin-java", "@prettier/plugin-php", "prettier-plugin-sh", "sh-syntax"]) {
    assert.match(pkg.devDependencies[name], /^\d+\.\d+\.\d+$/, `${name} must be pinned exactly`);
  }
});

test("the workspace skips library type checks (the bundled prettier plugins ship .d.ts files that do not check) and marks *.wasm binary", () => {
  const root = path.join(PLUGIN, "..", "..");
  assert.equal((JSON.parse(readFileSync(path.join(root, "tsconfig.base.json"), "utf8")) as { compilerOptions: { skipLibCheck: boolean } }).compilerOptions.skipLibCheck, true);
  assert.match(readFileSync(path.join(root, ".gitattributes"), "utf8"), /^\*\.wasm\s+binary\b/m);
});

// the bundled prettier made the resolver, the managed copy and the package runner dead code
test("no own module and no user-facing description mentions a managed copy, CLAUDE_PLUGIN_DATA or npx", () => {
  for (const f of OWN_MODULES) assert.doesNotMatch(read(f), /CLAUDE_PLUGIN_DATA|npx/, f);
  assert.doesNotMatch(pkg.description, /managed|npx/i);
  assert.doesNotMatch(hooks.description, /managed|npx/i);
});

test("nothing shipped names a removed shell/java/php CLI formatter", () => {
  for (const f of [...OWN_MODULES, "README.md", "hooks/hooks.json", ".claude-plugin/plugin.json"]) assert.doesNotMatch(read(f), /shfmt|php-cs-fixer|google-java-format|clang-format/, f);
});

test("README: Install is the first section, with the install command, and no Hooks section", () => {
  assert.equal(/^## .*$/m.exec(readme)?.[0], "## Install");
  assert.ok(readme.includes("/plugin install universal-format@kwitsch-plugins"));
  assert.doesNotMatch(readme, /^## Hooks/m);
});

test("README and the skill name none of the removed tools and no formatting after the write", () => {
  for (const f of ["README.md", "skills/universal-format/SKILL.md", "skills/universal-format/format-files.reference.md"]) {
    assert.doesNotMatch(read(f), /format_post|cwd_changed|worktree_entered|formatPost|CwdChanged|formatted after|reformatted on disk/, f);
  }
});

test("the README table and the hooks.json description cover the bundled-prettier and the CLI languages", () => {
  assert.equal(readme.split("in-process, before the write").length - 1, 13);
  assert.equal(readme.split("CLI on stdin, before the write").length - 1, 4);
  for (const t of ["Shell", "Java", "PHP", "LESS", "HTML", "Vue", "GraphQL"]) assert.ok(readme.includes(t), t);
  for (const t of ["shell", "java", "php", "less", "html", "vue", "graphql", "kotlin", "python", "go", "rust"]) assert.ok(hooks.description.includes(t), t);
});

test("README describes the base directory and the one ignore source, and promises no cwd gate", () => {
  assert.doesNotMatch(readme, /outside the project/);
  assert.ok(readme.includes("this plugin only ever reads the `.prettierignore` at the file's"));
  assert.ok(readme.includes("no Git root either — the file's own directory"));
  assert.ok(readme.includes("Defers to dprint"));
});
