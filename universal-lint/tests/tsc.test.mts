// tsc type-check and the combined eslint+tsc result; ported from test/universal-lint/tsc.bats.
import assert from "node:assert/strict";
import { chmodSync } from "node:fs";
import { test } from "vitest";
import { makeEnv } from "./support/lint-hook.mts";

/** Project with src/** tsconfig and a 2-line src/a.ts, for the Edit-range tests. */
/** Edit tool_response replacing line 1 of src/a.ts. */
const EDIT_L1 = { structuredPatch: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: ["-const x = 1;", "+const x: number = 1;", " const y: string = 2;"] }] };

/**
 * Project with src/** tsconfig and a 2-line src/a.ts, for the Edit-range tests.
 *
 * @returns The env and the file.
 */
function srcProj() {
  const e = makeEnv();
  e.file("tsconfig.json", "{\"compilerOptions\":{\"noEmit\":true},\"include\":[\"src/**/*.ts\"]}");
  return { e, a: e.file("src/a.ts", "const x: number = 1;\nconst y: string = 2;\n") };
}

test("tsc Edit: only the diagnostic on the edited line is reported", () => {
  const { e, a } = srcProj();
  e.recStub("tsc", 2);
  const r = e.run(a, {
    toolName: "Edit",
    toolResponse: EDIT_L1,
    out: "src/a.ts(1,1): error TS2322: line1-marker\nsrc/a.ts(2,1): error TS2322: line2-marker",
  });
  assert.equal(r.status, 2);
  assert.match(r.ctx, /line1-marker/);
  assert.doesNotMatch(r.ctx, /line2-marker/);
});

test("tsc Edit: a diagnostic only outside the edited line -> exit 0", () => {
  const { e, a } = srcProj();
  e.recStub("tsc", 2);
  const r = e.run(a, { toolName: "Edit", toolResponse: EDIT_L1, out: "src/a.ts(2,1): error TS2322: line2-marker" });
  assert.equal(r.status, 0);
  assert.equal(r.ctx, "");
});

/** A tsconfig.json that governs `*.ts` in the project root. */
const TSCONFIG = "{\"compilerOptions\":{\"noEmit\":true},\"include\":[\"*.ts\"]}";
const TS = "const x: number = 1;\n";

/** Project with the common tsconfig and a.ts. */
function proj() {
  const e = makeEnv();
  e.file("tsconfig.json", TSCONFIG);
  return { e, a: e.file("a.ts", TS) };
}

test("tsc: nearest tsconfig.json found upward, invoked with -p <path>, issues surfaced with project-root target", () => {
  const e = makeEnv();
  e.file("tsconfig.json", "{\"compilerOptions\":{\"noEmit\":true},\"include\":[\"src/**/*.ts\"]}");
  const a = e.file("src/a.ts", TS);
  e.recStub("tsc", 2);
  const r = e.run(a, { out: "src/a.ts(1,1): error TS2322: tsc-finding-marker" });
  assert.match(r.ctx, /tsc-finding-marker/);
  assert.ok(e.lines().some((l) => l.includes(`-p ${e.cwd}/tsconfig.json`)));
  assert.match(r.ctx, /found issues in \.:/);
});

test("tsc: no tsconfig.json anywhere -> {}, tsc stub never invoked", () => {
  const e = makeEnv();
  e.recStub("tsc", 2);
  assert.deepEqual(e.run(e.file("a.ts", TS), { out: "issue" }).result, {});
  assert.deepEqual(e.lines(), []);
});

test("tsc: solution-style tsconfig.json (references only) -> {}, tsc stub never invoked (confirmed blind spot)", () => {
  const e = makeEnv();
  e.file("tsconfig.json", "{\"files\":[],\"references\":[{\"path\":\"./pkg\"}]}");
  e.recStub("tsc", 2);
  assert.deepEqual(e.run(e.file("a.ts", TS), { out: "issue" }).result, {});
  assert.deepEqual(e.lines(), []);
});

test("tsc clean (exit 0) -> {}", () => {
  const { e, a } = proj();
  e.recStub("tsc", 0);
  assert.deepEqual(e.run(a).result, {});
});

test("tsc exit 1 (TypeScript 7 native compiler's real-diagnostic exit code, source location present) -> surfaced as issues", () => {
  const { e, a } = proj();
  e.recStub("tsc", 1);
  assert.match(e.run(a, { out: "a.ts(1,1): error TS2322: tsc-finding-marker" }).ctx, /tsc-finding-marker/);
});

test("tsc exit 1 (pure project/config-loading failure, no source-file location) -> {} (skip, not a real finding)", () => {
  const { e, a } = proj();
  e.recStub("tsc", 1);
  assert.deepEqual(e.run(a, { out: "error TS5083: Cannot read file '/proj/missing-base.json'." }).result, {});
});

test("tsc exit 1 (config-loading failure AND a real diagnostic together) -> the real finding still surfaces", () => {
  const { e, a } = proj();
  e.recStub("tsc", 1);
  const r = e.run(a, { out: "error TS5083: Cannot read file '/proj/missing-base.json'.\na.ts(1,1): error TS2322: tsc-finding-marker" });
  assert.match(r.ctx, /tsc-finding-marker/);
});

test("tsc exit 64 (unrecognized/crash) -> {} (skip bucket)", () => {
  const { e, a } = proj();
  e.recStub("tsc", 64);
  assert.deepEqual(e.run(a, { out: "unexpected crash" }).result, {});
});

test("tsc: .js file next to a real tsconfig.json never triggers tsc (extension-gated, not lang-gated)", () => {
  const e = makeEnv();
  e.file("tsconfig.json", "{\"compilerOptions\":{\"noEmit\":true,\"allowJs\":true},\"include\":[\"*.js\"]}");
  e.recStub("tsc", 2);
  e.recStub("eslint", 0);
  assert.deepEqual(e.run(e.file("a.js", "let x = 1;\n")).result, {});
  assert.ok(!e.lines().some((l) => l.startsWith("tsc ")));
});

test("tsc: absent from PATH but present at node_modules/.bin/tsc -> that absolute path is invoked directly", () => {
  const { e, a } = proj();
  const local = e.file(
    "node_modules/.bin/tsc",
    [
      "#!/usr/bin/env bash",
      "printf \"%s %s\\n\" \"localtsc\" \"$*\" >> \"$RECORD\"",
      "echo \"a.ts(1,1): error TS2322: local-tsc-marker\"",
      "exit 2",
      "",
    ].join("\n"),
  );
  chmodSync(local, 0o755);
  const r = e.run(a);
  assert.match(r.ctx, /local-tsc-marker/);
  assert.ok(e.lines().some((l) => l.startsWith("localtsc ")));
});

test("tsc: absent from PATH and no node_modules/.bin/tsc -> {}, no candidate", () => {
  const { e, a } = proj();
  assert.deepEqual(e.run(a).result, {});
});

test("combined: eslint (jsts chain) and tsc both report issues on the same .ts edit -> one additionalContext with both", () => {
  const { e, a } = proj();
  e.file("eslint.config.mjs", "export default [];\n");
  e.stub("eslint", "echo \"eslint-finding-marker\"", "exit 1");
  e.stub("tsc", "echo \"tsc-finding-marker\"", "exit 2");
  const r = e.run(a);
  assert.match(r.ctx, /eslint-finding-marker/);
  assert.match(r.ctx, /tsc-finding-marker/);
});

test("combined: outer truncate re-caps the WHOLE joined message even when both per-finding blocks are individually under MAX_CONTEXT_CHARS", () => {
  const { e, a } = proj();
  e.file("eslint.config.mjs", "export default [];\n");
  const big = "x".repeat(3000);
  e.stub("eslint", `echo "${big}"`, "exit 1");
  e.stub("tsc", `echo "${big}"`, "exit 2");
  const r = e.run(a);
  // each block (~3000 chars) is under the 4000-char per-finding cap, but joined (~6000+) must be re-capped by the outer truncate()
  assert.ok(r.ctx.length < 4200, String(r.ctx.length));
  assert.ok(r.ctx.endsWith("… (truncated)"));
});
