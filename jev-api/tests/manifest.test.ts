// pluginManifest (development/scripts/plugin-manifest.ts, shared by every plugin): the version must be a semver string.
import assert from "node:assert/strict";
import { test } from "vitest";
import { pluginManifest } from "../../development/scripts/plugin-manifest.ts";

const pkg = (version: unknown): Record<string, unknown> => ({ name: "x", version, description: "d", claudePlugin: {} });

test("pluginManifest rejects a version that is not semver", () => {
  for (const v of ["not a version", "1.0", "v1.0.0", "01.0.0", "1.0.0-", ""]) {
    assert.throws(() => pluginManifest(pkg(v)), /package\.json: .*"version"/, v);
  }
});

test("pluginManifest accepts semver versions with prerelease and build parts", () => {
  for (const v of ["0.5.1", "1.0.0-rc.1", "2.0.0+build.7"]) {
    assert.equal(pluginManifest(pkg(v)).version, v);
  }
});
