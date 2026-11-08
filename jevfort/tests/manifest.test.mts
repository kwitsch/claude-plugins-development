// Manifest and wiring contract of the built plugin/ (plugin.json is generated from package.json by pnpm build).
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "vitest";

/** Parsed JSON of a file under plugin/. */
const json = (rel: string) => JSON.parse(readFileSync(new URL(`../plugin/${rel}`, import.meta.url), "utf8"));
const manifest = json(".claude-plugin/plugin.json");

test("the manifest has name jevfort, version 0.2.0, author Kwitsch, a description and keywords", () => {
  assert.equal(manifest.name, "jevfort");
  assert.equal(manifest.version, "0.2.0");
  assert.equal(manifest.author.name, "Kwitsch");
  assert.ok(manifest.description.length > 0);
  assert.ok(Array.isArray(manifest.keywords) && manifest.keywords.length > 0);
});

test("userConfig declares exactly the 16 upstream options, mode active|off only", () => {
  assert.deepEqual(Object.keys(manifest.userConfig).sort(), [
    "agentTypes",
    "bypass",
    "classify",
    "compaction",
    "dangerDeny",
    "doneCheck",
    "doneThreshold",
    "gate",
    "measureSteps",
    "mode",
    "routing",
    "scopeDeny",
    "subagents",
    "takeOnlyForBypass",
    "takeSteps",
    "takeThreshold",
  ]);
  assert.deepEqual(manifest.userConfig.mode.options, ["active", "off"]);
  assert.equal(manifest.userConfig.mode.default, "active");
  for (const [k, v] of Object.entries(manifest.userConfig as Record<string, { type: string; title: string; description: string }>)) {
    assert.ok(v.type.length > 0 && v.title.length > 0 && v.description.length > 0, k);
  }
  assert.ok(!/shadow/i.test(readFileSync(new URL("../package.json", import.meta.url), "utf8")));
});

test("hooks.json is exactly the mods module list", () => {
  assert.deepEqual(json("hooks/hooks.json"), { modules: ["./register.mjs"] });
});

test("the built hooks modules exist", () => {
  for (const f of ["register", "jev", "policy", "candidates", "context", "log", "report", "prompt", "agents", "compact", "summarize"]) {
    assert.ok(existsSync(new URL(`../plugin/hooks/${f}.mjs`, import.meta.url)), f);
  }
});
