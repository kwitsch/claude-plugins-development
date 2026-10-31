// Tests for scripts/hooks.mjs: hooks.json validation and the generated hook input types.
// Each negative case runs the script against a scratch copy of the plugin with one defect.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts/hooks.mjs");
const HOOKS = JSON.parse(
  readFileSync(path.join(ROOT, "plugin/hooks/hooks.json"), "utf8"),
);

const run = (...args) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });

/** Scratch plugin root with the real files; `mutate(hooks)` edits a copy of hooks.json first. */
const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function scratch(mutate = () => {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "dprint-hooks-"));
  dirs.push(dir);
  mkdirSync(path.join(dir, "plugin/hooks"), { recursive: true });
  mkdirSync(path.join(dir, "src/mcp"), { recursive: true });
  for (const f of [
    "plugin.json",
    "plugin/.mcp.json",
    "src/mcp/hook-inputs.d.mts",
  ])
    cpSync(path.join(ROOT, f), path.join(dir, f));
  const hooks = structuredClone(HOOKS);
  mutate(hooks);
  writeFileSync(
    path.join(dir, "plugin/hooks/hooks.json"),
    JSON.stringify(hooks, null, 2),
  );
  return dir;
}

const formatPre = (h) => h.hooks.PreToolUse[0].hooks[0];

test("the committed hooks.json is valid and its generated types are current", () => {
  const r = run("--check");
  assert.equal(r.status, 0, r.stderr);
});

test("an unchanged scratch copy passes --check", () => {
  assert.equal(run("--check", scratch()).status, 0);
});

test("a placeholder that is not a field of the event's input is rejected", () => {
  const r = run(
    "--check",
    scratch((h) => (formatPre(h).input.tool_input.nope = "${tool_input.nope}")),
  );
  assert.equal(r.status, 1);
  assert.match(r.stderr, /placeholder \$\{tool_input\.nope\}/);
});

test("an input key that is not a TS identifier is rejected", () => {
  const r = run(
    "--check",
    scratch(
      (h) => (h.hooks.CwdChanged[0].hooks[0].input["new-cwd"] = "${new_cwd}"),
    ),
  );
  assert.equal(r.status, 1);
  assert.match(r.stderr, /new-cwd: input key must be a valid identifier/);
});

test("a CwdChanged-only field on PreToolUse is rejected", () => {
  const r = run(
    "--check",
    scratch((h) => (formatPre(h).input.cwd = "${new_cwd}")),
  );
  assert.equal(r.status, 1);
  assert.match(r.stderr, /placeholder \$\{new_cwd\}/);
});

test("a bare .mcp.json key as server is rejected (must be plugin:<name>:<key>)", () => {
  const r = run(
    "--check",
    scratch((h) => (formatPre(h).server = "dprint-hooks")),
  );
  assert.equal(r.status, 1);
  assert.match(r.stderr, /plugin:dprint:dprint-hooks/);
});

test("an event without known input fields is rejected", () => {
  const r = run(
    "--check",
    scratch((h) => (h.hooks.Stop = [{ hooks: [] }])),
  );
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Stop: event not known/);
});

test("a non-mcp_tool hook and a missing input are rejected", () => {
  const dir = scratch((h) => {
    h.hooks.PreToolUse.push({
      matcher: "Write",
      hooks: [{ type: "http" }],
    });
    delete h.hooks.CwdChanged[0].hooks[0].input;
  });
  const r = run("--check", dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /type must be "mcp_tool"/);
  assert.match(r.stderr, /input must be an object/);
});

test("one tool called with two different input shapes is rejected", () => {
  const r = run(
    "--check",
    scratch((h) =>
      h.hooks.PreToolUse.push({
        matcher: "Write",
        hooks: [{ ...formatPre(h), input: { cwd: "${cwd}" } }],
      }),
    ),
  );
  assert.equal(r.status, 1);
  assert.match(r.stderr, /format_pre is also called/);
});

test("a changed input template makes the types stale until regenerated", () => {
  const dir = scratch(
    (h) => (h.hooks.CwdChanged[0].hooks[0].input.old_cwd = "${old_cwd}"),
  );
  const stale = run("--check", dir);
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /stale/);
  assert.equal(run(dir).status, 0);
  assert.equal(run("--check", dir).status, 0);
  assert.match(
    readFileSync(path.join(dir, "src/mcp/hook-inputs.d.mts"), "utf8"),
    /old_cwd\?: string;/,
  );
});

test("a command hook needs a non-empty command", () => {
  for (const hook of [{ type: "command" }, { type: "command", command: "" }]) {
    const r = run(
      "--check",
      scratch((h) => h.hooks.CwdChanged[0].hooks.push(hook)),
    );
    assert.equal(r.status, 1, JSON.stringify(hook));
    assert.match(r.stderr, /command must be a non-empty string/);
  }
});

test("a command hook's timeout is still checked", () => {
  const r = run(
    "--check",
    scratch((h) =>
      h.hooks.CwdChanged[0].hooks.push({
        type: "command",
        command: "x",
        timeout: 0,
      }),
    ),
  );
  assert.equal(r.status, 1);
  assert.match(r.stderr, /timeout must be a positive integer/);
});

test("command hooks on SessionStart and FileChanged pass and generate no types", () => {
  const dir = scratch((h) => {
    h.hooks.SessionStart = [
      { hooks: [{ type: "command", command: "node x.mjs", timeout: 30 }] },
    ];
    // appended: replacing the shipped FileChanged mcp_tool group would drop FileChangedInput from the types
    (h.hooks.FileChanged ??= []).push({
      hooks: [{ type: "command", command: "node y.mjs" }],
    });
  });
  const r = run("--check", dir);
  assert.equal(r.status, 0, r.stderr);
});
