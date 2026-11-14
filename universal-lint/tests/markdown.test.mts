// markdownlint / markdownlint-cli2 chain, npx fallback and the MD013 guard; ported from test/universal-lint/markdown.bats.
// The MD013-off config is written to CLAUDE_PLUGIN_DATA on first use (it cannot ship as a loose file in plugin/).
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "vitest";
import { hashPath } from "../plugin/hooks/lint-file.mjs";
import { makeEnv } from "./support/lint-hook.mts";

const OUT = "a.md:1 MD041/first-line-heading";

test("markdown fallback: only markdownlint present -> used", () => {
  const e = makeEnv();
  e.recStub("markdownlint", 1);
  const r = e.run(e.file("a.md", "# hi\n"), { out: OUT });
  assert.match(r.ctx, /MD041/);
  assert.ok(e.lines().some((l) => l.startsWith("markdownlint ")));
  assert.ok(!e.lines().some((l) => l.includes("--no-globs"))); // classic markdownlint has no such option
});

test("markdown fallback: markdownlint-cli2 present -> wins over markdownlint (chain order)", () => {
  const e = makeEnv();
  e.recStub("markdownlint-cli2", 1);
  e.recStub("markdownlint", 1); // never runs: cli2 wins
  const r = e.run(e.file("a.md", "# hi\n"), { out: OUT });
  assert.match(r.ctx, /MD041/);
  assert.ok(e.lines().some((l) => l.startsWith("markdownlint-cli2 ")));
  assert.ok(!e.lines().some((l) => l.startsWith("markdownlint ")));
});

test("markdown: a directory named markdownlint-cli2 earlier on PATH is no hit, fresh or stored -> markdownlint runs", () => {
  const e = makeEnv();
  const early = path.join(e.data, "..", "early-bin");
  mkdirSync(path.join(early, "markdownlint-cli2"), { recursive: true });
  e.recStub("markdownlint", 1);
  const PATH = [early, e.bin].join(path.delimiter);
  const f = e.file("a.md", "# hi\n");
  assert.match(e.run(f, { out: OUT, env: { PATH } }).ctx, /MD041/);
  assert.ok(e.lines().some((l) => l.startsWith("markdownlint ")));
  // a stored directory hit must not be re-validated as present either
  const probe = path.join(e.data, `probe-${hashPath(PATH)}.json`);
  writeFileSync(probe, JSON.stringify({ hits: { "markdownlint-cli2": early }, misses: {} }));
  assert.match(e.run(f, { out: OUT, env: { PATH } }).ctx, /MD041/);
});

test("markdown: markdownlint on PATH, markdownlint-cli2 absent, npx present -> markdownlint wins (PATH beats npx-only)", () => {
  const e = makeEnv();
  e.recStub("markdownlint", 1);
  e.recStub("npx", 1); // present but must not be used: markdownlint is genuinely installed
  const r = e.run(e.file("a.md", "# hi\n"), { out: OUT });
  assert.match(r.ctx, /MD041/);
  assert.ok(e.lines().some((l) => l.startsWith("markdownlint ")));
  assert.ok(!e.lines().some((l) => l.includes("npx")));
});

test("markdownlint-cli2 absent but npx present -> npx --yes markdownlint-cli2 fallback runs", () => {
  const e = makeEnv();
  e.recStub("npx", 1);
  const f = e.file("a.md", "# hi\n");
  const r = e.run(f, { out: OUT });
  assert.match(r.ctx, /MD041/);
  assert.ok(e.lines().some((l) => l.includes(`npx --yes markdownlint-cli2 --no-globs --config ${path.join(e.data, "markdownlint-no-line-length.json")} :${f}`)));
});

test("markdownlint-cli2 gets its literal-path prefix, so a file name with glob characters is linted (not matched as a pattern)", () => {
  const e = makeEnv();
  e.file(".markdownlint.json", "{}\n");
  e.recStub("markdownlint-cli2", 0);
  const f = e.file("notes (1).md", "# hi\n");
  e.run(f);
  assert.ok(e.lines().some((l) => l.endsWith(`markdownlint-cli2 --no-globs :${f}`)));
});

test("markdown: no project markdownlint config -> --config <MD013-off file> in recorded argv, and the file disables only MD013", () => {
  const e = makeEnv();
  e.recStub("markdownlint-cli2", 0);
  e.run(e.file("a.md", "# hi\n"));
  const cfg = path.join(e.data, "markdownlint-no-line-length.json");
  assert.ok(e.lines().some((l) => l.includes(`--config ${cfg}`)));
  assert.deepEqual(JSON.parse(readFileSync(cfg, "utf8")), { MD013: false });
});

test("markdown: project .markdownlint.json present -> no --config override, only --no-globs before the file", () => {
  const e = makeEnv();
  e.file(".markdownlint.json", "{}\n");
  e.recStub("markdownlint-cli2", 0);
  const f = e.file("a.md", "# hi\n");
  e.run(f);
  assert.ok(!e.lines().some((l) => l.includes("markdownlint-no-line-length.json")));
  assert.ok(e.lines().some((l) => l.includes(`markdownlint-cli2 --no-globs :${f}`)));
});
