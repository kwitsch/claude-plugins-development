// Manifest and wiring contract of the built plugin/ (plugin.json is generated from package.json by pnpm build).
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { test } from "vitest";

/** Parsed JSON of a file under plugin/. */
const json = (rel: string) => JSON.parse(readFileSync(new URL(`../plugin/${rel}`, import.meta.url), "utf8"));
const manifest = json(".claude-plugin/plugin.json");
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("the manifest declares the jev-api plugin as its only dependency, and package.json has no npm dependencies", () => {
  assert.deepEqual(manifest.dependencies, ["jev-api"]);
  assert.deepEqual(pkg.claudePlugin.dependencies, ["jev-api"]);
  assert.equal(pkg.dependencies, undefined);
  assert.match(manifest.description, /jev-api/);
});

test("userConfig declares exactly 15 options: no mode selector, no gate", () => {
  assert.deepEqual(Object.keys(manifest.userConfig).sort(), [
    "agentTypes",
    "autoCompactPercent",
    "bypass",
    "compaction",
    "forceCompactPercent",
    "haikuCompact",
    "maxEffort",
    "minEffort",
    "routing",
    "stepEffort",
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

test("routing is a boolean on by default, with no model mode", () => {
  assert.deepEqual({ ...manifest.userConfig.routing, title: "", description: "" }, { type: "boolean", title: "", description: "", default: true });
  assert.ok(!("options" in manifest.userConfig.routing));
});

test("minEffort and maxEffort are effort-level strings defaulting to low and xhigh", () => {
  const levels = ["low", "medium", "high", "xhigh", "max"];
  assert.deepEqual({ ...manifest.userConfig.minEffort, title: "", description: "" }, { type: "string", title: "", description: "", options: levels, default: "low" });
  assert.deepEqual({ ...manifest.userConfig.maxEffort, title: "", description: "" }, { type: "string", title: "", description: "", options: levels, default: "xhigh" });
});

test("every userConfig key pins type, default, min and max, and the default matches the README Options table", () => {
  const pct = (d: number) => ({ type: "number", default: d, min: 0, max: 100 });
  const bool = { type: "boolean", default: true };
  const effort = (d: string) => ({ type: "string", default: d });
  const expected: Record<string, Record<string, unknown>> = {
    routing: bool,
    stepEffort: { type: "boolean", default: false },
    takeSteps: bool,
    subagents: bool,
    bypass: bool,
    agentTypes: bool,
    compaction: bool,
    haikuCompact: bool,
    takeOnlyForBypass: bool,
    takeThreshold: { type: "number", default: 0.85 },
    taskCompactPercent: pct(80),
    forceCompactPercent: pct(95),
    autoCompactPercent: pct(60),
    minEffort: effort("low"),
    maxEffort: effort("xhigh"),
  };
  const readme = readFileSync(new URL("../plugin/README.md", import.meta.url), "utf8");
  const rows = new Map([...readme.matchAll(/^\| `(\w+)`\s*\| `([^`]+)`/gm)].map((m) => [m[1], m[2]]));
  for (const [k, v] of Object.entries(manifest.userConfig as Record<string, Record<string, unknown>>)) {
    const { type, default: def, min, max } = v;
    assert.deepEqual({ type, default: def, min, max }, { min: undefined, max: undefined, ...expected[k] }, k);
    assert.equal(rows.get(k), String(def), k);
  }
});

test("hooks.json is exactly the mods module list", () => {
  assert.deepEqual(json("hooks/hooks.json"), { modules: ["./register.js"] });
});

test("the hooks ship as one register.js; no helper module, no lib.mjs", () => {
  assert.ok(existsSync(new URL("../plugin/hooks/register.js", import.meta.url)));
  assert.deepEqual(readdirSync(new URL("../plugin/hooks/", import.meta.url)).filter((f) => /\.m?js$/.test(f)), ["register.js"]);
});

test("the README mentions skill or plan hints only where it says the 0.12.0 removal", () => {
  const readme = readFileSync(new URL("../plugin/README.md", import.meta.url), "utf8");
  const hintLines = readme.split("\n").filter((line) => /\bhints?\b/i.test(line));
  assert.deepEqual(hintLines.map((line) => line.slice(0, 20)), ["Coming from 0.11: th"]);
});
