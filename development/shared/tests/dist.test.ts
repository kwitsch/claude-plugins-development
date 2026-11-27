import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "vitest";
import * as graphmindPaths from "../src/graphmind-paths.ts";
import * as mcpCore from "../src/mcp-core.ts";
import * as scope from "../src/scope.ts";

/** The build output directory of the package. */
const DIST = fileURLToPath(new URL("../dist/", import.meta.url));
/** Each entry's source module, by the entry name that is also its `dist/<name>.mjs` file. */
const ENTRIES: Record<string, Record<string, unknown>> = { scope, "mcp-core": mcpCore, "graphmind-paths": graphmindPaths };
/** Whether `dist/` exists: these tests check the built package, as process tests need a built `plugin/`. */
const built = existsSync(DIST);
/** Appended to every title so a skipped run says why. */
const reason = built ? "" : " [skipped: dist/ missing, run pnpm --filter @kwitsch/claude-code-plugin-shared build first]";

for (const [name, src] of Object.entries(ENTRIES)) {
  test.skipIf(!built)(`dist/${name}.mjs and dist/${name}.d.mts exist${reason}`, () => {
    assert.ok(existsSync(path.join(DIST, `${name}.mjs`)), `dist/${name}.mjs missing`);
    assert.ok(existsSync(path.join(DIST, `${name}.d.mts`)), `dist/${name}.d.mts missing`);
  });

  test.skipIf(!built)(`dist/${name}.mjs exports the same names as src/${name}.ts${reason}`, async () => {
    const dist = (await import(pathToFileURL(path.join(DIST, `${name}.mjs`)).href)) as Record<string, unknown>;
    assert.deepEqual(Object.keys(dist).sort(), Object.keys(src).sort());
  });
}

test.skipIf(!built)(`dist/*.mjs imports only node: builtins and relative chunks${reason}`, () => {
  const files = readdirSync(DIST).filter((f) => f.endsWith(".mjs"));
  assert.ok(files.length >= Object.keys(ENTRIES).length, `only ${files.length} .mjs files in dist/`);
  for (const f of files) {
    const code = readFileSync(path.join(DIST, f), "utf8");
    for (const m of code.matchAll(/\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
      const spec = m[1];
      assert.ok(spec.startsWith("node:") || spec.startsWith("./") || spec.startsWith("../"), `${f} imports ${spec}`);
    }
  }
});
