// oxlint vs eslint vs no chain lint selection by the nearest lint config file, and the oxlint-typeCheck tsc gate.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "vitest";
import { makeEnv } from "./support/lint-hook.mts";

/** A tsconfig.json that governs `*.ts` in the project root. */
const TSCONFIG = "{\"compilerOptions\":{\"noEmit\":true},\"include\":[\"*.ts\"]}";
const TS = "const x: number = 1;\n";
const JS = "let x = 1;\n";

test("oxlint: .oxlintrc.json selects oxlint, exit 1 surfaced, eslint never spawned", () => {
  const e = makeEnv();
  e.recStub("oxlint", 1);
  e.recStub("eslint", 1);
  const cfg = e.file(".oxlintrc.json", "{}");
  const f = e.file("src/a.ts", TS);
  const r = e.run(f, { out: "oxlint-finding-marker" });
  assert.match(r.ctx, /oxlint found issues in src\/a\.ts/);
  assert.match(r.ctx, /oxlint-finding-marker/);
  assert.ok(e.lines().some((l) => l.includes(`oxlint --no-error-on-unmatched-pattern -c ${cfg} ${f}`)));
  assert.ok(!e.lines().some((l) => l.startsWith("eslint ")));
});

for (const code of [0, 2]) {
  test(`oxlint: exit ${code} -> {}`, () => {
    const e = makeEnv();
    e.file(".oxlintrc.json", "{}");
    e.recStub("oxlint", code);
    e.recStub("eslint", 1);
    assert.deepEqual(e.run(e.file("src/a.ts", TS), { out: "noise" }).result, {});
  });
}

test("oxlint: no lint config anywhere -> no chain lint: eslint, oxlint and npx never spawned, {}", () => {
  const e = makeEnv();
  e.recStub("oxlint", 1);
  e.recStub("eslint", 1);
  e.recStub("npx", 1);
  const r = e.run(e.file("a.js", JS), { out: "noise" });
  assert.deepEqual(r.result, {});
  assert.deepEqual(e.lines(), []);
});

for (const placement of ["cwd", "one level above cwd"]) {
  test(`oxlint: eslint.config.mjs in ${placement} -> eslint runs`, () => {
    const e = makeEnv();
    // one level above cwd is the per-env makeEnv base dir (holds bin/, home/, proj/), never higher
    if (placement === "cwd") e.file("eslint.config.mjs", "export default [];\n");
    else writeFileSync(path.join(e.cwd, "..", "eslint.config.mjs"), "export default [];\n");
    e.recStub("eslint", 0);
    e.run(e.file("a.js", JS));
    assert.ok(e.lines().some((l) => l.startsWith("eslint ")));
  });
}

test("oxlint: eslint.config.mjs and .oxlintrc.json in the same dir -> oxlint wins", () => {
  const e = makeEnv();
  e.file("eslint.config.mjs", "export default [];\n");
  e.file(".oxlintrc.json", "{}");
  e.recStub("oxlint", 0);
  e.recStub("eslint", 1);
  e.run(e.file("a.js", JS));
  assert.ok(e.lines().some((l) => l.startsWith("oxlint ")));
  assert.ok(!e.lines().some((l) => l.startsWith("eslint ")));
});

test("oxlint: absent from PATH but npx present -> npx --yes oxlint fallback runs", () => {
  const e = makeEnv();
  const cfg = e.file(".oxlintrc.json", "{}");
  e.recStub("npx", 1);
  const f = e.file("a.js", JS);
  e.run(f, { out: "oxlint-finding-marker" });
  assert.ok(e.lines().some((l) => l.includes(`npx --yes oxlint --no-error-on-unmatched-pattern -c ${cfg} ${f}`)));
});

test("oxlint: nested oxlint.config.ts is passed via -c (oxlint ignores nested .ts configs on its own)", () => {
  const e = makeEnv();
  e.file(".oxlintrc.json", "{}");
  const cfg = e.file("pkg/oxlint.config.ts", "export default {};\n");
  e.recStub("oxlint", 0);
  const f = e.file("pkg/a.js", JS);
  e.run(f);
  assert.ok(e.lines().some((l) => l.includes(`oxlint --no-error-on-unmatched-pattern -c ${cfg} ${f}`)));
});

test("oxlint: selected but no oxlint and no npx -> {}, no eslint fallback", () => {
  const e = makeEnv();
  e.file(".oxlintrc.json", "{}");
  assert.deepEqual(e.run(e.file("a.js", JS)).result, {});
  assert.deepEqual(e.lines(), []);
});

/**
 * Project with tsconfig.json, the given lint config, clean oxlint/eslint stubs and a tsc stub reporting an issue; edits a.ts.
 *
 * @param configName - Lint config file name at the project root.
 * @param config - Its content.
 * @param oxlintExit - Exit code of the oxlint stub, or null for no oxlint (nor npx) at all.
 * @returns The hook result and whether tsc was spawned.
 */
function gate(configName: string, config: string, oxlintExit: number | null = 0): { result: object; tscRan: boolean } {
  const e = makeEnv();
  e.file("tsconfig.json", TSCONFIG);
  e.file(configName, config);
  if (oxlintExit !== null) e.recStub("oxlint", oxlintExit);
  e.recStub("eslint", 0);
  e.recStub("tsc", 2);
  const r = e.run(e.file("a.ts", TS), { out: "a.ts(1,1): error TS2322: tsc-finding-marker" });
  return { result: r.result, tscRan: e.lines().some((l) => l.startsWith("tsc ")) };
}

test("tsc gate: .oxlintrc.json with options.typeCheck true -> tsc not spawned, {}", () => {
  const g = gate(".oxlintrc.json", "{\"options\":{\"typeAware\":true,\"typeCheck\":true}}");
  assert.equal(g.tscRan, false);
  assert.deepEqual(g.result, {});
});

test("tsc gate: .oxlintrc.jsonc with a comment, trailing comma and typeCheck true -> tsc not spawned", () => {
  const g = gate(".oxlintrc.jsonc", "// oxlint\n{\n  \"options\": {\n    \"typeAware\": true,\n    \"typeCheck\": true,\n  },\n}\n");
  assert.equal(g.tscRan, false);
});

test("tsc gate: typeCheck false -> tsc spawned", () => {
  assert.equal(gate(".oxlintrc.json", "{\"options\":{\"typeCheck\":false}}").tscRan, true);
});

test("tsc gate: typeCheck absent -> tsc spawned", () => {
  assert.equal(gate(".oxlintrc.json", "{}").tscRan, true);
});

test("tsc gate: oxlint.config.ts -> tsc spawned", () => {
  assert.equal(gate("oxlint.config.ts", "export default { options: { typeCheck: true } };\n").tscRan, true);
});

test("tsc gate: malformed .oxlintrc.json -> tsc spawned", () => {
  assert.equal(gate(".oxlintrc.json", "{\"options\":").tscRan, true);
});

test("tsc gate: eslint config -> tsc spawned (eslint path unchanged)", () => {
  assert.equal(gate("eslint.config.mjs", "export default [];\n").tscRan, true);
});

test("tsc gate: no lint config -> tsc still spawned, no chain lint", () => {
  const e = makeEnv();
  e.file("tsconfig.json", TSCONFIG);
  e.recStub("eslint", 1);
  e.recStub("npx", 1);
  e.recStub("tsc", 2);
  const r = e.run(e.file("a.ts", TS), { out: "a.ts(1,1): error TS2322: tsc-finding-marker" });
  assert.match(r.ctx, /tsc-finding-marker/);
  assert.ok(e.lines().some((l) => l.startsWith("tsc ")));
  assert.ok(!e.lines().some((l) => l.startsWith("eslint ") || l.startsWith("npx ")));
});

const TYPE_CHECK_CFG = "{\"options\":{\"typeAware\":true,\"typeCheck\":true}}";

test("tsc gate: typeCheck true but oxlint unavailable -> tsc spawned", () => {
  assert.equal(gate(".oxlintrc.json", TYPE_CHECK_CFG, null).tscRan, true);
});

test("tsc gate: typeCheck true but oxlint skip verdict (exit 2) -> tsc spawned", () => {
  assert.equal(gate(".oxlintrc.json", TYPE_CHECK_CFG, 2).tscRan, true);
});

test("tsc gate: typeCheck true and oxlint reports issues (exit 1) -> tsc not spawned", () => {
  assert.equal(gate(".oxlintrc.json", TYPE_CHECK_CFG, 1).tscRan, false);
});
