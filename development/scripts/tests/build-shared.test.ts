import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, test } from "vitest";

const BUILD = path.resolve(import.meta.dirname, "..", "build-plugin.ts");
const tmp = mkdtempSync(path.join(os.tmpdir(), "build-shared-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Writes files (path to content) below a fresh directory and returns it. */
function tree(name: string, files: Record<string, string>): string {
  const dir = path.join(tmp, name);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

const PKG = JSON.stringify({ name: "fixture", version: "1.0.0", description: "d", claudePlugin: {} });

/** Builds the fixture plugin against a fixture shared folder. */
function build(plugin: string, shared: string, extraPkg?: object) {
  if (extraPkg) writeFileSync(path.join(plugin, "package.json"), JSON.stringify({ ...JSON.parse(PKG), ...extraPkg }));
  return spawnSync(process.execPath, [BUILD, plugin], { encoding: "utf8", env: { ...process.env, PLUGIN_SHARED_SRC: shared } });
}

test("a shared module is shipped with its own shared imports and the imports are rewritten relative", () => {
  const shared = tree("s1", {
    "a.ts": "import { b } from \"./b.js\";\nexport const a = (): string => b() + \"a\";\n",
    "b.ts": "export const b = (): string => \"b\";\n",
    "deep/c.ts": "import { b } from \"@shared/b.js\";\nexport const c = (): string => b();\n",
    "unused.ts": "export const unused = 1;\n",
  });
  const plugin = tree("p1", {
    "package.json": PKG,
    "src/mcp/server.ts": "import { a } from \"@shared/a.js\";\nimport { c } from \"@shared/deep/c.js\";\nconsole.log(a(), c());\n",
  });
  const r = build(plugin, shared);
  assert.equal(r.status, 0, r.stderr);
  const server = readFileSync(path.join(plugin, "plugin/mcp/server.mjs"), "utf8");
  assert.match(server, /"\.\.\/shared\/a\.mjs"/);
  assert.match(server, /"\.\.\/shared\/deep\/c\.mjs"/);
  assert.doesNotMatch(readFileSync(path.join(plugin, "plugin/shared/deep/c.mjs"), "utf8"), /@shared/);
  assert.ok(existsSync(path.join(plugin, "plugin/shared/b.mjs")), "transitively imported module ships");
  assert.ok(!existsSync(path.join(plugin, "plugin/shared/unused.mjs")), "an unimported module does not ship");
  // the shipped plugin runs without the repository
  const run = spawnSync(process.execPath, [path.join(plugin, "plugin/mcp/server.mjs")], { encoding: "utf8" });
  assert.equal(run.stdout.trim(), "ba b");
});

test("a shared module that is no longer imported disappears from plugin/ on the next build", () => {
  const shared = tree("s2", { "a.ts": "export const a = 1;\n" });
  const plugin = tree("p2", { "package.json": PKG, "src/x.ts": "import { a } from \"@shared/a.js\";\nconsole.log(a);\n" });
  assert.equal(build(plugin, shared).status, 0);
  assert.ok(existsSync(path.join(plugin, "plugin/shared/a.mjs")));
  writeFileSync(path.join(plugin, "src/x.ts"), "console.log(1);\n");
  assert.equal(build(plugin, shared).status, 0);
  assert.ok(!existsSync(path.join(plugin, "plugin/shared/a.mjs")));
});

test("a missing shared module, a bad name, a re-export, a source clash and a lib bundle fail the build and keep the old output", () => {
  const shared = tree("s3", { "a.ts": "export const a = 1;\n" });
  const cases: [string, Record<string, string>, RegExp, object?][] = [
    ["missing", { "src/x.ts": "import { n } from \"@shared/nope.js\";\nconsole.log(n);\n" }, /has no source/],
    ["badname", { "src/x.ts": "import { n } from \"@shared/../a.js\";\nconsole.log(n);\n" }, /not a shared module name/],
    ["reexport", { "src/x.ts": "export { a } from \"@shared/a.js\";\n" }, /static `import` only/],
    ["clash", { "src/shared/a.ts": "export const z = 1;\n", "src/x.ts": "import { a } from \"@shared/a.js\";\nconsole.log(a);\n" }, /would overwrite/],
    ["bundle", { "src/hooks/register.ts": "import { a } from \"@shared/a.js\";\nexport const r = a;\n", "plugin/hooks/hooks.json": "{\"modules\":[\"./register.mjs\"]}" }, /cannot import @shared modules from hooks/, { pluginBuild: { bundleHooksLib: true } }],
  ];
  for (const [name, files, message, pkg] of cases) {
    const plugin = tree(`p3-${name}`, { "package.json": PKG, "plugin/old.mjs": "export {};\n", ...files });
    const r = build(plugin, shared, pkg);
    assert.notEqual(r.status, 0, name);
    assert.match(r.stderr, message, name);
    assert.ok(existsSync(path.join(plugin, "plugin/old.mjs")), `${name}: a failed build leaves the old output`);
  }
});

test("a bundleHooksLib plugin may import shared code outside hooks/ (its MCP server)", () => {
  const shared = tree("s4", { "a.ts": "export const a = 1;\n" });
  const plugin = tree("p4", {
    "package.json": PKG,
    "src/hooks/register.ts": "export const r = 1;\n",
    "src/mcp/server.ts": "import { a } from \"@shared/a.js\";\nconsole.log(a);\n",
    "plugin/hooks/hooks.json": "{\"modules\":[\"./register.mjs\"]}",
  });
  const r = build(plugin, shared, { pluginBuild: { bundleHooksLib: true } });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(path.join(plugin, "plugin/shared/a.mjs")));
});
