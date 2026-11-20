import assert from "node:assert/strict";
import { test } from "vitest";
import { binaryDirs } from "../src/graphmind-paths.ts";

test("binaryDirs: absolute PATH entries first, then the places the setup scripts add", () => {
  assert.deepEqual(binaryDirs("/a/:rel:/b", "/home/u"), ["/a", "/b", "/home/u/.graphmind/bin", "/home/u/.local/bin", "/usr/local/bin"]);
  assert.deepEqual(binaryDirs(undefined, undefined), ["/usr/local/bin"]);
  assert.deepEqual(binaryDirs("//:/usr/bin", undefined), ["/", "/usr/bin", "/usr/local/bin"]);
});
