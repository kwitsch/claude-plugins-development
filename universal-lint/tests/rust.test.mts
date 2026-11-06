// Rust (cargo clippy/check) detection, manifest targeting, chain preference, the no-Cargo.toml gate and exit-code
// classification; ported from test/universal-lint/rust.bats.
import assert from "node:assert/strict";
import { test } from "vitest";
import { makeEnv } from "./support/lint-hook.mts";

/** A project with a Cargo.toml and src/main.rs. */
function crate(content = "fn main() {}\n") {
  const e = makeEnv();
  e.file("Cargo.toml", "[package]\nname = \"x\"\n");
  return { e, main: e.file("src/main.rs", content) };
}

test("rust: only cargo(check) on PATH -> invoked, targets --manifest-path, no positional", () => {
  const { e, main } = crate();
  e.recStub("cargo", 0);
  e.run(main, { out: "error[E0000]: some finding" });
  assert.ok(e.lines().some((l) => l.includes(`cargo check --manifest-path ${e.cwd}/Cargo.toml`)));
  assert.ok(!e.lines().some((l) => l.includes("main.rs"))); // no trailing file positional
});

test("rust: cargo-clippy on PATH gates selection, but the actual run is 'cargo clippy' (not the bare driver)", () => {
  const { e, main } = crate();
  // cargo-clippy only needs to be executable for the PATH probe; recording so an accidental direct invocation
  // (the regression this test guards against) would leave its own "cargo-clippy ..." line
  e.recStub("cargo-clippy", 1);
  e.recStub("cargo", 0);
  e.run(main, { out: "warning: some clippy finding" });
  assert.ok(e.lines().some((l) => l.includes(`cargo clippy --manifest-path ${e.cwd}/Cargo.toml -- -D warnings`)));
  assert.ok(!e.lines().some((l) => l.startsWith("cargo-clippy "))); // the bare driver was only probed
});

test("rust: .rs with no Cargo.toml anywhere -> {} and the stub is never invoked (manifest gate)", () => {
  const e = makeEnv();
  e.recStub("cargo", 101);
  assert.deepEqual(e.run(e.file("src/main.rs", "fn main() {}\n"), { out: "error: should never appear" }).result, {});
  assert.ok(!e.lines().some((l) => l.includes("cargo")));
});

test("rust: nothing on PATH -> {} (no npx attempt)", () => {
  const { e, main } = crate();
  assert.deepEqual(e.run(main).result, {});
});

test("rust: cargo check exit 0 (clean) -> {}", () => {
  const { e, main } = crate();
  e.recStub("cargo", 0);
  assert.deepEqual(e.run(main).result, {});
});

test("rust: cargo check exit 101 -> additionalContext finding whose target is the crate dir", () => {
  const { e, main } = crate("fn main() { let x = ; }\n");
  e.recStub("cargo", 101);
  const r = e.run(main, { out: "error: expected expression" });
  assert.match(r.ctx, /expected expression/);
  assert.match(r.ctx, /found issues in \.:/);
});
