// The dprint priority gate (`dprintGoverns` in handlers.ts): universal-format formats nothing inside a working
// directory that has a dprint config while the dprint plugin is enabled. Through the spawned server, so HOME (the
// anchor of the user settings) is the sandbox's and the developer's own settings never reach a test.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, test } from "vitest";
import { CONFIG_NAMES } from "../../dprint/src/skills/dprint/config-names.ts";
import { DPRINT_CONFIG_NAMES } from "../src/mcp/handlers.ts";
import { cleanup, type Sandbox, sandbox, type Server } from "./support/mcp.ts";
import type { HookOut } from "./support/plugin.ts";

afterEach(cleanup);

const UNFORMATTED = "const a={b:1}";
const FORMATTED = "const a = { b: 1 };\n";
const ENABLED = { enabledPlugins: { "dprint@kwitsch-plugins": true } };
const DISABLED = { enabledPlugins: { "dprint@kwitsch-plugins": false } };

/**
 * Writes a settings file.
 *
 * @param file - The file path.
 * @param settings - An object is JSON-encoded, a string written as it is (malformed cases).
 */
function writeSettings(file: string, settings: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof settings === "string" ? settings : JSON.stringify(settings));
}

/**
 * A sandbox with its server; the user settings are written when given.
 *
 * @param userSettings - Content of `~/.claude/settings.json`.
 * @returns The sandbox and the server.
 */
function start(userSettings?: unknown): { s: Sandbox; server: Server } {
  const s = sandbox();
  if (userSettings !== undefined) writeSettings(path.join(s.home, ".claude", "settings.json"), userSettings);
  return { s, server: s.server() };
}

/**
 * Creates a dprint config.
 *
 * @param dir - The directory.
 * @param name - The config's name relative to it.
 */
function writeDprintConfig(dir: string, name = "dprint.json"): void {
  mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
  writeFileSync(path.join(dir, name), "{}\n");
}

/**
 * `format_pre` for a Write of the unformatted TypeScript fixture.
 *
 * @param server - The server.
 * @param cwd - The session's working directory.
 * @param file - The target file, `a.ts` in the cwd by default.
 * @returns The hook result.
 */
const preWrite = (server: Server, cwd: string, file = path.join(cwd, "a.ts")): Promise<HookOut> => server.write(file, UNFORMATTED, cwd);

const assertFormatted = (out: HookOut, msg: string): void => assert.equal(out.hookSpecificOutput.updatedInput.content, FORMATTED, msg);

test("the config names are dprint's own (a name added there must be copied here)", () => {
  assert.deepEqual([...DPRINT_CONFIG_NAMES], [...CONFIG_NAMES]);
});

test("dprint gate: dprint.json in cwd + dprint enabled at user scope -> {}", async () => {
  const { s, server } = start(ENABLED);
  writeDprintConfig(s.proj);
  assert.deepEqual(await preWrite(server, s.proj), {}, "dprint governs this cwd: universal-format must format nothing");
});

test("dprint gate: CLAUDE_CONFIG_DIR names the user settings directory", async () => {
  const s = sandbox();
  writeDprintConfig(s.proj);
  writeSettings(path.join(s.root, "config", "settings.json"), ENABLED);
  assert.deepEqual(await preWrite(s.server({ CLAUDE_CONFIG_DIR: path.join(s.root, "config") }), s.proj), {});
});

test("dprint gate: the .config/dprint.jsonc variant counts as a dprint config", async () => {
  const { s, server } = start(ENABLED);
  writeDprintConfig(s.proj, path.join(".config", "dprint.jsonc"));
  assert.deepEqual(await preWrite(server, s.proj), {});
});

test("dprint gate: a config in a parent dir of cwd is found when no .git sits between them", async () => {
  const { s, server } = start(ENABLED);
  writeDprintConfig(s.proj);
  const cwd = path.join(s.proj, "child");
  mkdirSync(cwd);
  assert.deepEqual(await preWrite(server, cwd), {}, "dprint's findConfig walks up from cwd until a directory holding .git");
});

test("dprint gate: the walk stops at a cwd holding .git, so a config above it does not count", async () => {
  const { s, server } = start(ENABLED);
  writeDprintConfig(s.proj);
  const cwd = path.join(s.proj, "repo");
  mkdirSync(path.join(cwd, ".git"), { recursive: true });
  assertFormatted(await preWrite(server, cwd), "dprint parity: the walk ends after the directory holding .git");
});

test("dprint gate: no dprint@ entry in enabledPlugins at any scope -> still formatted", async () => {
  const { s, server } = start({ enabledPlugins: { "universal-format@kwitsch-plugins": true } });
  writeDprintConfig(s.proj);
  assertFormatted(await preWrite(server, s.proj), "no dprint@ key anywhere means dprint is not active");
});

test("dprint gate: an enabled dprint of one marketplace counts although another marketplace's is disabled in the same file", async () => {
  const { s, server } = start({ enabledPlugins: { "dprint@dev": false, "dprint@kwitsch-plugins": true } });
  writeDprintConfig(s.proj);
  assert.deepEqual(await preWrite(server, s.proj), {});
});

test("dprint gate: the most specific settings file wins (local > project > user)", async () => {
  const { s, server } = start(ENABLED);
  writeDprintConfig(s.proj);
  writeSettings(path.join(s.proj, ".claude", "settings.json"), DISABLED);
  assertFormatted(await preWrite(server, s.proj), "project-scope false overrides user-scope true");
  // the settings are read on every call: no restart
  writeSettings(path.join(s.proj, ".claude", "settings.local.json"), ENABLED);
  assert.deepEqual(await preWrite(server, s.proj), {}, "local-scope true overrides project-scope false");
});

test("dprint gate: no dprint config, dprint enabled -> still formatted", async () => {
  const { s, server } = start(ENABLED);
  assertFormatted(await preWrite(server, s.proj), "dprint enabled but nothing for it to format here");
});

test("dprint gate: a malformed user settings file fails toward formatting", async () => {
  const { s, server } = start("{");
  writeDprintConfig(s.proj);
  assertFormatted(await preWrite(server, s.proj), "unreadable settings must never silence universal-format");
});

test("dprint gate: an out-of-cwd write is formatted even when cwd is dprint-governed", async () => {
  const { s, server } = start(ENABLED);
  writeDprintConfig(s.proj);
  const other = path.join(s.root, "other");
  mkdirSync(path.join(other, ".git"), { recursive: true });
  assertFormatted(await preWrite(server, s.proj, path.join(other, "a.ts")), "outside the cwd dprint's hook would not touch this file");
});

test("dprint gate: no CLI formatter runs in a dprint-governed cwd (stub-proven), a cwd without a config still runs it", async () => {
  const { s, server } = start(ENABLED);
  writeDprintConfig(s.proj);
  s.recStub("gofmt");
  assert.deepEqual(await server.write(path.join(s.proj, "main.go"), "package main\n"), {});
  assert.equal(s.recorded(), "", "the stub must not have run: {} alone is also what 'no formatter on PATH' answers");
  const plain = path.join(s.root, "plain");
  mkdirSync(plain);
  assert.equal((await server.write(path.join(plain, "main.go"), "package main\n", plain)).hookSpecificOutput.updatedInput.content, "reformatted-by-gofmt\n", "positive control: the gate, not a missing tool, produced the {} above");
});

test("dprint gate: config presence is re-checked per call (created / deleted out of band)", async () => {
  const { s, server } = start(ENABLED);
  assertFormatted(await preWrite(server, s.proj), "no config yet: formatted");
  writeDprintConfig(s.proj);
  assert.deepEqual(await preWrite(server, s.proj), {}, "a config created without a Write/Edit is seen immediately");
  rmSync(path.join(s.proj, "dprint.json"));
  assertFormatted(await preWrite(server, s.proj), "a config deleted out of band (git rm, branch switch) is seen immediately");
});

test("dprint gate: a session in a repo subdirectory reads project settings at the git root", async () => {
  const { s, server } = start();
  mkdirSync(path.join(s.proj, ".git"));
  writeDprintConfig(s.proj);
  writeSettings(path.join(s.proj, ".claude", "settings.json"), ENABLED);
  const cwd = path.join(s.proj, "packages", "app");
  mkdirSync(cwd, { recursive: true });
  assert.deepEqual(await preWrite(server, cwd), {}, "repo-root .claude/settings.json enables dprint for a subdirectory session");
});

test("dprint gate: a prettier config written while dprint governs is honored once dprint is disabled", async () => {
  const { s, server } = start();
  writeDprintConfig(s.proj);
  const projectSettings = path.join(s.proj, ".claude", "settings.json");
  assertFormatted(await preWrite(server, s.proj), "dprint not enabled yet: formatted, prettier's negative config lookup is cached");
  writeSettings(projectSettings, ENABLED);
  const rc = path.join(s.proj, ".prettierrc");
  assert.deepEqual(await server.write(rc, JSON.stringify({ semi: false })), {}, "the hook on the config Write, while gated");
  writeFileSync(rc, JSON.stringify({ semi: false })); // the Write tool lands it
  assert.deepEqual(await preWrite(server, s.proj), {}, "still gated");
  writeSettings(projectSettings, DISABLED);
  assert.equal((await preWrite(server, s.proj)).hookSpecificOutput.updatedInput.content, "const a = { b: 1 }\n", "the .prettierrc written while gated must be in force");
});
