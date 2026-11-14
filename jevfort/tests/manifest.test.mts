// Manifest and wiring contract of the built plugin/ (plugin.json is generated from package.json by pnpm build).
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "vitest";

/** Parsed JSON of a file under plugin/. */
const json = (rel: string) => JSON.parse(readFileSync(new URL(`../plugin/${rel}`, import.meta.url), "utf8"));
const manifest = json(".claude-plugin/plugin.json");

test("the manifest has name jevfort, version 0.10.1, author Kwitsch, a description and keywords", () => {
  assert.equal(manifest.name, "jevfort");
  assert.equal(manifest.version, "0.10.1");
  assert.equal(manifest.author.name, "Kwitsch");
  assert.ok(manifest.description.length > 0);
  assert.ok(Array.isArray(manifest.keywords) && manifest.keywords.length > 0);
});

test("the manifest declares the jev-api plugin as its only dependency, and package.json has no npm dependencies", () => {
  assert.deepEqual(manifest.dependencies, ["jev-api"]);
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(pkg.claudePlugin.dependencies, ["jev-api"]);
  assert.equal(pkg.dependencies, undefined);
  assert.match(manifest.description, /jev-api/);
});

test("userConfig declares exactly 18 options: no mode selector, no gate", () => {
  assert.deepEqual(Object.keys(manifest.userConfig).sort(), [
    "agentTypes",
    "autoCompactPercent",
    "bypass",
    "classify",
    "compaction",
    "doneCheck",
    "doneThreshold",
    "forceCompactPercent",
    "haikuCompact",
    "maxEffort",
    "measureSteps",
    "minEffort",
    "routing",
    "subagents",
    "takeOnlyForBypass",
    "takeSteps",
    "takeThreshold",
    "taskCompactPercent",
  ]);
  for (const [k, v] of Object.entries(manifest.userConfig as Record<string, { type: string; title: string; description: string }>)) {
    assert.ok(v.type.length > 0 && v.title.length > 0 && v.description.length > 0, k);
  }
  assert.ok(!/shadow/i.test(readFileSync(new URL("../package.json", import.meta.url), "utf8")));
});

test("minEffort and maxEffort are effort-level strings defaulting to low and xhigh", () => {
  const levels = ["low", "medium", "high", "xhigh", "max"];
  assert.deepEqual({ ...manifest.userConfig.minEffort, title: "", description: "" }, { type: "string", title: "", description: "", options: levels, default: "low" });
  assert.deepEqual({ ...manifest.userConfig.maxEffort, title: "", description: "" }, { type: "string", title: "", description: "", options: levels, default: "xhigh" });
});

test("hooks.json is exactly the mods module list", () => {
  assert.deepEqual(json("hooks/hooks.json"), { modules: ["./register.mjs"] });
});

test("the built hooks modules exist", () => {
  for (const f of ["register", "jev", "policy", "candidates", "context", "log", "report", "prompt", "agents", "compact", "summarize", "cache"]) {
    assert.ok(existsSync(new URL(`../plugin/hooks/${f}.mjs`, import.meta.url)), f);
  }
});
