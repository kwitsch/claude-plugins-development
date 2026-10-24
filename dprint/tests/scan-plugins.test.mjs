// Shape test for the shipped plugin/skills/init-dprint/dprint-plugins.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../plugin/skills/init-dprint",
);
const REF = JSON.parse(
  readFileSync(path.join(DIR, "dprint-plugins.json"), "utf8"),
);

test("dprint-plugins.json: every plugin has a unique id, lower-case dot-free extensions, and at least one file type", () => {
  assert.ok(Array.isArray(REF.plugins));
  const ids = new Set();
  for (const p of REF.plugins) {
    assert.equal(typeof p.id, "string");
    assert.ok(p.id.length > 0);
    assert.ok(!ids.has(p.id), `duplicate id ${p.id}`);
    ids.add(p.id);
    assert.ok(Array.isArray(p.extensions), p.id);
    for (const x of p.extensions)
      assert.match(x, /^[a-z0-9]+$/, `${p.id}: ${x}`);
    for (const n of p.fileNames ?? []) {
      assert.equal(typeof n, "string");
      assert.ok(n.length > 0 && !n.includes("/"), `${p.id}: ${n}`);
    }
    assert.ok(p.extensions.length + (p.fileNames?.length ?? 0) > 0, p.id);
  }
});
