// jevUrl: the JEV_URL environment variable, trimmed, else the TypeSafe default; only http(s) URLs are accepted.
import assert from "node:assert/strict";
import { test } from "vitest";
import { DEFAULT_JEV_URL, jevUrl } from "../plugin/hooks/jev.mjs";

const ERROR = { ok: false, error: "JEV_URL must be an http(s) URL" };

test("unset or blank JEV_URL falls back to the TypeSafe API", () => {
  assert.equal(DEFAULT_JEV_URL, "https://api.typesafe.ai/v1/systemone");
  assert.deepEqual(jevUrl(undefined), { ok: true, url: DEFAULT_JEV_URL });
  assert.deepEqual(jevUrl(""), { ok: true, url: DEFAULT_JEV_URL });
  assert.deepEqual(jevUrl("   "), { ok: true, url: DEFAULT_JEV_URL });
});

test("an http(s) URL is accepted for any host, trimmed, scheme case-insensitive", () => {
  assert.deepEqual(jevUrl("  https://jev.example.test/v1/x  "), { ok: true, url: "https://jev.example.test/v1/x" });
  assert.deepEqual(jevUrl("http://example.com"), { ok: true, url: "http://example.com" });
  assert.deepEqual(jevUrl("http://localhost:8080/v1"), { ok: true, url: "http://localhost:8080/v1" });
  assert.deepEqual(jevUrl("HTTP://JEV.EXAMPLE/x"), { ok: true, url: "HTTP://JEV.EXAMPLE/x" });
});

test("anything that is not an http(s) URL is an error, so no request is sent", () => {
  for (const bad of ["not a url", "ftp://x", "file:///etc/passwd", "https://", "https://a b/x"]) {
    assert.deepEqual(jevUrl(bad), ERROR, bad);
  }
});
