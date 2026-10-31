// Contract tests for the built plugin/skills/init-dprint/scan-plugins.mjs and a shape test for the
// shipped dprint-plugins.json. Isolated PATH (only node + git), HOME and git repo per test.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../plugin/skills/init-dprint",
);
const SCRIPT = path.join(DIR, "scan-plugins.mjs");
const REF = JSON.parse(
  readFileSync(path.join(DIR, "dprint-plugins.json"), "utf8"),
);
const cands = (ext) =>
  REF.plugins
    .filter((p) => p.extensions.includes(ext))
    .map((p) => p.id)
    .join(",");
const JSON_URL = "https://plugins.dprint.dev/json-0.25.2.wasm";
const TS_URL = "https://plugins.dprint.dev/typescript-0.96.1.wasm";

let tmp, bin, home, repo;
beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "dprint-scan-test-"));
  bin = path.join(tmp, "bin");
  home = path.join(tmp, "home");
  repo = path.join(tmp, "repo");
  for (const d of [bin, home, repo]) mkdirSync(d);
  for (const t of ["node", "git"]) {
    const src = spawnSync("sh", ["-c", `command -v ${t}`], {
      encoding: "utf8",
    }).stdout.trim();
    if (src) symlinkSync(src, path.join(bin, t));
  }
  spawnSync(path.join(bin, "git"), ["init", "-q"], {
    cwd: repo,
    env: { PATH: bin, HOME: home },
  });
});

/** create repo/<rel> (and its parent dirs) with the given content */
function write(rel, text = "") {
  const f = path.join(repo, rel);
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, text);
}
/** a dprint.json body listing the given plugin entries */
const config = (...plugins) => JSON.stringify({ plugins });
function run(...args) {
  const r = spawnSync(path.join(bin, "node"), [SCRIPT, ...args], {
    cwd: repo,
    env: { PATH: bin, HOME: home },
    encoding: "utf8",
  });
  return { code: r.status, lines: r.stdout.trim().split("\n"), err: r.stderr };
}

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

test("no config file -> exit 11, status=noconfig", () => {
  write("a.ts");
  const r = run();
  assert.equal(r.code, 11);
  assert.deepEqual(r.lines, ["status=noconfig config=- missing=-"]);
});

test("all detected types covered (URL with checksum suffix) -> exit 0", () => {
  write("a.ts");
  write("dprint.json", config(`${TS_URL}@abc`, JSON_URL));
  const r = run();
  assert.equal(r.code, 0);
  assert.deepEqual(r.lines, ["status=ok config=dprint.json missing=0"]);
});

test("only .config/dprint.json -> it is the config, exit 0", () => {
  write("a.ts");
  write(".config/dprint.json", config(TS_URL, JSON_URL));
  const r = run();
  assert.equal(r.code, 0);
  assert.deepEqual(r.lines, ["status=ok config=.config/dprint.json missing=0"]);
});

test("uncovered types -> exit 10, sorted by file count, candidates from the reference", () => {
  write("a.ts");
  write("b.ts");
  write("src/c.toml");
  write("x.unknownext");
  write("dprint.json", config(JSON_URL));
  const r = run();
  assert.equal(r.code, 10);
  assert.deepEqual(r.lines, [
    "status=missing config=dprint.json missing=2",
    `type=.ts files=2 candidates=${cands("ts")}`,
    `type=.toml files=1 candidates=${cands("toml")}`,
  ]);
});

test("dprint.jsonc with comments and trailing commas is parsed; // inside URLs survives", () => {
  write("a.ts");
  write(
    ".dprint.jsonc",
    [
      "{",
      "  // line comment",
      '  "plugins": [',
      `    "${TS_URL}", /* block comment */`,
      `    "${JSON_URL}", // trailing comma before ]`,
      "  ],",
      "  /* multi",
      "     line */",
      '  "lineWidth": 100,',
      "}",
      "",
    ].join("\n"),
  );
  const r = run();
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.lines, ["status=ok config=.dprint.jsonc missing=0"]);
});

test("npm specifier and node_modules path count as present", () => {
  write("a.ts");
  write(
    "dprint.json",
    config(
      "npm:@dprint/typescript@0.95.0",
      "./node_modules/@dprint/json/plugin.wasm",
    ),
  );
  const r = run();
  assert.equal(r.code, 0);
  assert.deepEqual(r.lines, ["status=ok config=dprint.json missing=0"]);
});

test(".gitignore'd files are not scanned", () => {
  write(".gitignore", "dist/\n");
  write("dist/x.css");
  write("dprint.json", config(JSON_URL));
  const r = run();
  assert.equal(r.code, 0);
  assert.deepEqual(r.lines, ["status=ok config=dprint.json missing=0"]);
});

test("exact file names and upper-case extensions are recognized", () => {
  write("Dockerfile");
  write("README.MD");
  write("dprint.json", config(JSON_URL));
  const docker = REF.plugins
    .filter((p) => p.fileNames?.includes("Dockerfile"))
    .map((p) => p.id)
    .join(",");
  const r = run();
  assert.equal(r.code, 10);
  assert.equal(r.lines[0], "status=missing config=dprint.json missing=2");
  assert.ok(
    r.lines.includes(`type=.md files=1 candidates=${cands("md")}`),
    r.lines.join("\n"),
  );
  assert.ok(
    r.lines.includes(`type=Dockerfile files=1 candidates=${docker}`),
    r.lines.join("\n"),
  );
});

test("extends -> stderr warning, exit code unchanged", () => {
  write(
    "dprint.json",
    JSON.stringify({
      extends: "https://example.com/base.json",
      plugins: [JSON_URL],
    }),
  );
  const r = run();
  assert.equal(r.code, 0);
  assert.deepEqual(r.lines, ["status=ok config=dprint.json missing=0"]);
  assert.match(r.err, /extends/);
});

test("invalid config -> exit 2, status=error", () => {
  write("dprint.json", '{ "plugins": [');
  const r = run();
  assert.equal(r.code, 2);
  assert.deepEqual(r.lines, ["status=error config=dprint.json missing=-"]);
});

test("not a git work tree -> exit 2", () => {
  const plain = path.join(tmp, "plain");
  mkdirSync(plain);
  writeFileSync(path.join(plain, "dprint.json"), config(JSON_URL));
  const r = spawnSync(path.join(bin, "node"), [SCRIPT], {
    cwd: plain,
    env: { PATH: bin, HOME: home, GIT_CEILING_DIRECTORIES: tmp },
    encoding: "utf8",
  });
  assert.equal(r.status, 2);
  assert.equal(r.stdout.trim(), "status=error config=dprint.json missing=-");
  assert.match(r.stderr, /git ls-files/);
});

test("any argument is a usage error -> exit 2", () => {
  write("dprint.json", config(JSON_URL));
  const r = run("--help");
  assert.equal(r.code, 2);
  assert.deepEqual(r.lines, ["status=error config=- missing=-"]);
});
