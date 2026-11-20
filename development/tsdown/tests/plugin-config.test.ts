// pluginConfig() of the tsdown build standard, run through tsdown's build() on fixture plugins in a temp directory.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "tsdown";
import { afterAll, test } from "vitest";
import { pluginManifest } from "../../scripts/plugin-manifest.ts";
import { pluginConfig, type PluginEntries } from "../index.ts";

const tmp = mkdtempSync(path.join(os.tmpdir(), "plugin-config-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** A valid plugin package.json. */
const PKG = { name: "fixture", version: "1.0.0", description: "d", claudePlugin: {} };
/** A mod entry that takes a helper module and a shared module, and uses the engine names `$` and `on`. */
const MOD = [
  "import { binaryDirs } from \"@shared/graphmind-paths.js\";",
  "import { shout } from \"./helper.js\";",
  "export const register = (on: (event: string, hook: ($: { env: { get(name: string): Promise<string | undefined> } }) => Promise<unknown>) => void): void => {",
  "  on(\"session.start\", async ($) => shout(binaryDirs(await $.env.get(\"PATH\"), undefined).join(\":\")));",
  "};",
  "",
].join("\n");
/** A script entry with a shebang that takes the same helper and shared module. */
const SCRIPT = [
  "#!/usr/bin/env node",
  "import { basename } from \"node:path\";",
  "import { binaryDirs } from \"@shared/graphmind-paths.js\";",
  "import { shout } from \"../hooks/helper.js\";",
  "console.log(shout(basename(binaryDirs(\"/opt/x\", undefined)[0] ?? \"\")));",
  "",
].join("\n");
/** The helper module both entries import. */
const HELPER = "export const shout = (text: string): string => text.toUpperCase();\n";

/**
 * Writes files (path to content) below a fresh directory.
 *
 * @param name - Directory name below the temp directory.
 * @param files - File contents by relative path; `package.json` defaults to a valid one.
 * @returns The directory.
 */
function tree(name: string, files: Record<string, string>): string {
  const dir = path.join(tmp, name);
  for (const [rel, text] of Object.entries({ "package.json": JSON.stringify(PKG), ...files })) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

/**
 * Builds a fixture plugin as `tsdown` does with the plugin's config: one build per returned config, in order.
 *
 * @param root - The plugin directory.
 * @param entries - The plugin's entries.
 */
async function run(root: string, entries: PluginEntries): Promise<void> {
  for (const config of pluginConfig(entries, root)) await build({ ...config, config: false, logLevel: "silent" });
}

/**
 * The import specifiers left in built code.
 *
 * @param code - The built file.
 * @returns Every `from "..."` and `import("...")` specifier.
 */
const specifiers = (code: string): string[] => [...code.matchAll(/(?:from|import)\s*\(?\s*["'`]([^"'`]+)["'`]/g)].map((m) => m[1]);

test("a mod is built to .js, compressed but not mangled, without a shebang, with helper and @shared inlined", async () => {
  const root = tree("mod", { "src/hooks/register.ts": MOD, "src/hooks/helper.ts": HELPER });
  await run(root, { mods: ["hooks/register"] });
  const code = readFileSync(path.join(root, "plugin/hooks/register.js"), "utf8");
  assert.match(code, /\bregister\b/);
  assert.match(code, /\$\.env\.get\(/);
  assert.match(code, /\bon\(/);
  assert.match(code, /binaryDirs/, "top-level names are not mangled");
  assert.ok(!code.startsWith("#!"));
  assert.deepEqual(specifiers(code), []);
  assert.ok(code.split("\n").length <= 2, "compressed to one line");
  assert.ok(!existsSync(path.join(root, "plugin/hooks/helper.js")) && !existsSync(path.join(root, "plugin/shared")), "no helper file, no shared copy");
});

test("a script is built to .mjs, minified, with the shebang, executable and runnable on its own", async () => {
  const root = tree("script", { "src/bin/tool.ts": SCRIPT, "src/hooks/helper.ts": HELPER });
  await run(root, { scripts: ["bin/tool"] });
  const file = path.join(root, "plugin/bin/tool.mjs");
  const code = readFileSync(file, "utf8");
  assert.ok(code.startsWith("#!/usr/bin/env node\n"));
  assert.ok((statSync(file).mode & 0o111) !== 0, "executable");
  assert.deepEqual(specifiers(code), ["node:path"]);
  assert.doesNotMatch(code, /binaryDirs/, "mangled");
  assert.equal(spawnSync(file, { encoding: "utf8" }).stdout, "X\n");
});

test("plugin.json equals pluginManifest(package.json) and several entries each get their own file", async () => {
  const pkg = { ...PKG, author: { name: "A" }, keywords: ["k"], private: true, claudePlugin: { userConfig: { x: { type: "string" } } } };
  const root = tree("manifest", { "package.json": JSON.stringify(pkg), "src/hooks/register.ts": MOD, "src/hooks/helper.ts": HELPER, "src/bin/tool.ts": SCRIPT });
  await run(root, { mods: ["hooks/register"], scripts: ["bin/tool"] });
  const text = readFileSync(path.join(root, "plugin/.claude-plugin/plugin.json"), "utf8");
  assert.equal(text, JSON.stringify(pluginManifest(pkg), null, 2) + "\n");
  assert.deepEqual(JSON.parse(text), JSON.parse(JSON.stringify(pluginManifest(pkg))));
  assert.ok(existsSync(path.join(root, "plugin/hooks/register.js")) && existsSync(path.join(root, "plugin/bin/tool.mjs")));
});

test("stale .mjs and .js output is removed, pluginBuild.assets and hand-written files stay", async () => {
  const root = tree("stale", {
    "package.json": JSON.stringify({ ...PKG, pluginBuild: { assets: ["vendor/keep.mjs"] } }),
    "src/hooks/register.ts": MOD,
    "src/hooks/helper.ts": HELPER,
    "src/bin/tool.ts": SCRIPT,
    "plugin/hooks/lib.mjs": "export {};\n",
    "plugin/hooks/old.js": "export {};\n",
    "plugin/shared/x.mjs": "export {};\n",
    "plugin/vendor/keep.mjs": "export {};\n",
    "plugin/README.md": "# fixture\n",
    "plugin/hooks/hooks.json": "{\"modules\": [\"./register.js\"]}\n",
  });
  await run(root, { mods: ["hooks/register"], scripts: ["bin/tool"] });
  for (const gone of ["hooks/lib.mjs", "hooks/old.js", "shared/x.mjs"]) assert.ok(!existsSync(path.join(root, "plugin", gone)), `${gone} is removed`);
  for (const kept of ["vendor/keep.mjs", "README.md", "hooks/hooks.json", "hooks/register.js", "bin/tool.mjs"]) assert.ok(existsSync(path.join(root, "plugin", kept)), `${kept} stays`);
});

/** Sources that must fail the build, with the text the error names. */
const failing: { name: string; entries: PluginEntries; files: Record<string, string>; error: RegExp }[] = [
  { name: "a bare builtin import", entries: { scripts: ["bin/tool"] }, files: { "src/bin/tool.ts": "#!/usr/bin/env node\nimport { readFileSync } from \"fs\";\nconsole.log(typeof readFileSync);\n" }, error: /not self-contained, it imports fs/ },
  { name: "a dynamic import()", entries: { mods: ["hooks/register"] }, files: { "src/hooks/register.ts": "export const register = async (): Promise<unknown> => import(\"./helper.js\");\n", "src/hooks/helper.ts": HELPER }, error: /expected exactly one output file/ },
  { name: "a script without a shebang", entries: { scripts: ["bin/tool"] }, files: { "src/bin/tool.ts": "console.log(1);\n" }, error: /line 1 of a script source must be #!\/usr\/bin\/env node/ },
  { name: "a mod with a shebang", entries: { mods: ["hooks/register"] }, files: { "src/hooks/register.ts": "#!/usr/bin/env node\nexport const register = (): void => {};\n" }, error: /a mod must not start with a shebang/ },
  { name: "a package.json without claudePlugin", entries: { mods: ["hooks/register"] }, files: { "package.json": JSON.stringify({ ...PKG, claudePlugin: undefined }), "src/hooks/register.ts": "export const register = (): void => {};\n" }, error: /claudePlugin/ },
  { name: "a file plugin/ may not hold", entries: { mods: ["hooks/register"] }, files: { "src/hooks/register.ts": "export const register = (): void => {};\n", "plugin/hooks/register.ts": "export {};\n" }, error: /may not contain/ },
];
for (const [i, c] of failing.entries()) {
  test(`the build fails on ${c.name}`, async () => {
    const root = tree(`fail${i}`, c.files);
    await assert.rejects(run(root, c.entries), c.error);
    assert.ok(!existsSync(path.join(root, "plugin/.claude-plugin/plugin.json")), "nothing is written");
  });
}

/** Entry lists pluginConfig refuses before any build. */
const invalid: { name: string; entries: PluginEntries; error: RegExp }[] = [
  { name: "an empty entry list", entries: {}, error: /no entry listed/ },
  { name: "an unknown entry", entries: { mods: ["hooks/missing"] }, error: /src\/hooks\/missing\.ts: listed as a mod entry/ },
  { name: "an entry with an extension", entries: { scripts: ["hooks/register.ts"] }, error: /invalid script entry "hooks\/register\.ts"/ },
  { name: "an entry leaving src/", entries: { mods: ["../x"] }, error: /invalid mod entry/ },
  { name: "an entry listed twice", entries: { mods: ["hooks/register", "hooks/register"] }, error: /listed twice/ },
  { name: "a vendor directory without index.d.ts", entries: { mods: ["hooks/register"], vendor: ["mcp/vendor"] }, error: /src\/mcp\/vendor\/index\.d\.ts: listed as a vendor directory/ },
  { name: "a vendor directory leaving src/", entries: { mods: ["hooks/register"], vendor: ["../vendor"] }, error: /invalid vendor directory/ },
  { name: "a vendor directory listed twice", entries: { mods: ["hooks/register"], vendor: ["hooks", "hooks"] }, error: /vendor directory "hooks" is listed twice/ },
];
for (const c of invalid) {
  test(`pluginConfig refuses ${c.name}`, () => {
    const root = tree("invalid", { "src/hooks/register.ts": "export const register = (): void => {};\n", "src/hooks/index.d.ts": "export {};\n" });
    assert.throws(() => pluginConfig(c.entries, root), c.error);
  });
}

test("every config builds one entry into plugin/ and only the first carries the manifest plugin", () => {
  const root = tree("shape", { "src/hooks/register.ts": MOD, "src/bin/tool.ts": SCRIPT });
  const configs = pluginConfig({ mods: ["hooks/register"], scripts: ["bin/tool"] }, root);
  assert.deepEqual(configs.map((c) => c.entry), [{ "hooks/register": path.join(root, "src/hooks/register.ts") }, { "bin/tool": path.join(root, "src/bin/tool.ts") }]);
  assert.deepEqual(configs.map((c) => c.minify), [{ mangle: false, compress: true }, true]);
  assert.deepEqual(configs.map((c) => (c.plugins as { name: string }[]).map((p) => p.name)), [["plugin-build:check", "plugin-build:manifest"], ["plugin-build:check"]]);
  assert.ok(configs.every((c) => c.outDir === path.join(root, "plugin") && c.clean === false));
});

/** The declaration of a fixture's vendored bundle. */
const VENDOR_DTS = "export declare const answer: number;\n";
/** The vendored bundle a plugin's own build step would have written. */
const VENDOR_FILES = { "src/mcp/vendor/index.d.ts": VENDOR_DTS, "plugin/mcp/vendor/index.mjs": "export { answer } from \"./chunk-abc.mjs\";\n", "plugin/mcp/vendor/chunk-abc.mjs": "export const answer = 42;\n" };

test("a script beside the vendor directory keeps ./vendor/index.mjs external, the bundle survives the stale removal and the script runs", async () => {
  const root = tree("vendor-near", {
    ...VENDOR_FILES,
    "src/mcp/server.ts": "#!/usr/bin/env node\nimport { answer } from \"./vendor/index.js\";\nconsole.log(answer);\n",
    "plugin/mcp/old.mjs": "export {};\n",
  });
  await run(root, { scripts: ["mcp/server"], vendor: ["mcp/vendor"] });
  const file = path.join(root, "plugin/mcp/server.mjs");
  assert.deepEqual(specifiers(readFileSync(file, "utf8")), ["./vendor/index.mjs"]);
  assert.ok(!existsSync(path.join(root, "plugin/mcp/old.mjs")), "stale output outside the vendor directory is removed");
  for (const kept of ["index.mjs", "chunk-abc.mjs"]) assert.ok(existsSync(path.join(root, "plugin/mcp/vendor", kept)), `${kept} stays`);
  assert.equal(spawnSync(file, { encoding: "utf8" }).stdout, "42\n");
});

test("a script in another directory that reaches the vendor bundle through a helper gets the path from its own output", async () => {
  const root = tree("vendor-far", {
    ...VENDOR_FILES,
    "src/mcp/helper.ts": "import { answer } from \"./vendor/index.js\";\nexport const twice = (): number => answer * 2;\n",
    "src/skills/s/run.ts": "#!/usr/bin/env node\nimport { twice } from \"../../mcp/helper.js\";\nconsole.log(twice());\n",
  });
  await run(root, { scripts: ["skills/s/run"], vendor: ["mcp/vendor"] });
  const file = path.join(root, "plugin/skills/s/run.mjs");
  assert.deepEqual(specifiers(readFileSync(file, "utf8")), ["../../mcp/vendor/index.mjs"]);
  assert.equal(spawnSync(file, { encoding: "utf8" }).stdout, "84\n");
});

test("the build fails on a relative import of an undeclared vendor directory", async () => {
  const root = tree("vendor-undeclared", { "src/mcp/vendor/index.d.ts": VENDOR_DTS, "src/mcp/server.ts": "#!/usr/bin/env node\nimport { answer } from \"./vendor/index.js\";\nconsole.log(answer);\n" });
  await assert.rejects(run(root, { scripts: ["mcp/server"] }));
  assert.ok(!existsSync(path.join(root, "plugin/mcp/server.mjs")), "nothing is written");
});

test("vitest resolves a source's ./vendor/index.js to the plugin's built vendor bundle", async () => {
  const { BUNDLED_PRETTIER_VERSION } = await import("../../../universal-format/src/mcp/prettier.ts");
  assert.match(BUNDLED_PRETTIER_VERSION, /^\d+\.\d+\.\d+/);
});

/** A mod entry without imports. */
const PLAIN_MOD = "export const register = (): void => {};\n";

test("a symlinked directory entry below plugin/ fails the build and its target is unchanged", async () => {
  const root = tree("symlink-entry", { "src/hooks/register.ts": PLAIN_MOD, "plugin/skills/data.json": "{}\n" });
  const outside = path.join(tmp, "symlink-entry-outside");
  mkdirSync(outside);
  writeFileSync(path.join(outside, "precious.mjs"), "keep me");
  symlinkSync(outside, path.join(root, "plugin/skills/shared.json"));
  await assert.rejects(run(root, { mods: ["hooks/register"] }), /may not contain/);
  assert.equal(readFileSync(path.join(outside, "precious.mjs"), "utf8"), "keep me");
});

test("a symlinked plugin/ fails the build and its target is unchanged", async () => {
  const root = tree("symlink-root", { "src/hooks/register.ts": PLAIN_MOD });
  const outside = path.join(tmp, "symlink-root-outside");
  mkdirSync(path.join(outside, "sub"), { recursive: true });
  writeFileSync(path.join(outside, "precious.mjs"), "keep me");
  writeFileSync(path.join(outside, "sub/other.mjs"), "keep me too");
  symlinkSync(outside, path.join(root, "plugin"));
  await assert.rejects(run(root, { mods: ["hooks/register"] }), /may not contain/);
  assert.equal(readFileSync(path.join(outside, "precious.mjs"), "utf8"), "keep me");
  assert.equal(readFileSync(path.join(outside, "sub/other.mjs"), "utf8"), "keep me too");
});

test("a symlinked plugin.json fails the build and its target is unchanged", async () => {
  const root = tree("symlink-manifest", { "src/hooks/register.ts": PLAIN_MOD, "plugin/README.md": "# fixture\n" });
  const outside = path.join(tmp, "symlink-manifest-outside");
  mkdirSync(outside);
  writeFileSync(path.join(outside, "victim.txt"), "PRECIOUS");
  mkdirSync(path.join(root, "plugin/.claude-plugin"));
  symlinkSync(path.join(outside, "victim.txt"), path.join(root, "plugin/.claude-plugin/plugin.json"));
  await assert.rejects(run(root, { mods: ["hooks/register"] }), /may not contain/);
  assert.equal(readFileSync(path.join(outside, "victim.txt"), "utf8"), "PRECIOUS");
});
