// Go directory-scoping and golangci-lint/go-vet fallback; ported from test/universal-lint/go.bats.
import assert from "node:assert/strict";
import { test } from "vitest";
import { makeEnv } from "./support/lint-hook.mts";

test("go fallback: only go(vet) stub present -> used, targets the directory", () => {
  const e = makeEnv();
  e.recStub("go", 1);
  e.run(e.file("pkg/a.go", "package pkg\n"), { out: "pkg/a.go:1: some vet finding" });
  assert.ok(e.lines().some((l) => l.includes(`go vet ${e.cwd}/pkg`) && !l.includes("a.go")));
});

test("go fallback: golangci-lint present -> wins over go vet, targets the directory", () => {
  const e = makeEnv();
  e.recStub("golangci-lint", 1);
  e.recStub("go", 1); // never runs (golangci-lint wins)
  e.run(e.file("pkg/a.go", "package pkg\n"), { out: "pkg/a.go:1: some finding" });
  assert.ok(e.lines().some((l) => l.includes(`golangci-lint run ${e.cwd}/pkg`)));
  assert.ok(!e.lines().some((l) => l.includes("go vet")));
});
