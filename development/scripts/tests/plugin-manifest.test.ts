// pluginManifest (plugin-manifest.ts) and the generated manifest of every plugin: package.json is the source, plugin.json its build output.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "vitest";
import { pluginManifest } from "../plugin-manifest.ts";

const REPO = path.resolve(import.meta.dirname, "..", "..", "..");
const pkgOf = (version: unknown): Record<string, unknown> => ({ name: "x", version, description: "d", claudePlugin: {} });

test("pluginManifest rejects a version that is not semver", () => {
  for (const v of ["not a version", "1.0", "v1.0.0", "01.0.0", "1.0.0-", ""]) {
    assert.throws(() => pluginManifest(pkgOf(v)), /package\.json: .*"version"/, v);
  }
});

test("pluginManifest accepts semver versions with prerelease and build parts", () => {
  for (const v of ["0.5.1", "1.0.0-rc.1", "2.0.0+build.7"]) {
    assert.equal(pluginManifest(pkgOf(v)).version, v);
  }
});

test("pluginManifest requires the claudePlugin marker CI detects plugins by", () => {
  assert.throws(() => pluginManifest({ name: "x", version: "1.0.0", description: "d" }), /"claudePlugin" must be an object/);
  assert.equal(pluginManifest(pkgOf("1.0.0")).name, "x");
});

/** The plugins of the repository: the directories whose package.json carries `claudePlugin`. */
const plugins = readdirSync(REPO, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(path.join(REPO, d.name, "package.json")))
  .map((d) => d.name)
  .filter((name) => "claudePlugin" in (JSON.parse(readFileSync(path.join(REPO, name, "package.json"), "utf8")) as object));

test("the repository holds the plugins this test expects to find", () => {
  assert.ok(plugins.length >= 9, plugins.join(", "));
  assert.ok(plugins.includes("dprint") && plugins.includes("jevfort"));
});

describe("plugin.json is exactly what package.json generates (name, version, author, description, keywords, claudePlugin fields; run after pnpm build)", () => {
  for (const name of plugins) {
    test(name, () => {
      const pkg = JSON.parse(readFileSync(path.join(REPO, name, "package.json"), "utf8")) as Record<string, unknown>;
      const built = JSON.parse(readFileSync(path.join(REPO, name, "plugin", ".claude-plugin", "plugin.json"), "utf8")) as unknown;
      assert.deepEqual(built, JSON.parse(JSON.stringify(pluginManifest(pkg))));
    });
  }
});
