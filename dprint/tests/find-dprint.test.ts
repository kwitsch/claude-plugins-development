// Tests for src/skills/dprint/find-dprint.ts: a failed npx probe is cached for NPX_RETRY_MS, and a wall
// clock stepped back must not keep it cached. Date.now is mocked; the npx stub counts its runs in a file.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import { findDprint } from "../src/skills/dprint/find-dprint.ts";

const T0 = 1_000_000_000_000;
const RETRY_MS = 30_000;

let tmp: string;
let oldPath: string | undefined;
let oldInstall: string | undefined;
beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "find-dprint-test-"));
  oldPath = process.env.PATH;
  oldInstall = process.env.DPRINT_INSTALL;
});
afterEach(() => {
  vi.restoreAllMocks();
  process.env.PATH = oldPath;
  if (oldInstall === undefined) delete process.env.DPRINT_INSTALL;
  else process.env.DPRINT_INSTALL = oldInstall;
  rmSync(tmp, { recursive: true, force: true });
});

test("a failed npx probe is cached for NPX_RETRY_MS, and a wall clock stepped back does not keep it cached", async () => {
  const bin = path.join(tmp, "bin");
  mkdirSync(bin);
  const runs = path.join(tmp, "runs");
  writeFileSync(path.join(bin, "npx"), `#!/bin/sh\necho run >> '${runs}'\nexit 1\n`);
  chmodSync(path.join(bin, "npx"), 0o755);
  process.env.PATH = bin;
  process.env.DPRINT_INSTALL = path.join(tmp, "none");
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const probes = () => (existsSync(runs) ? readFileSync(runs, "utf8").split("\n").filter(Boolean).length : 0);
  const clock = vi.spyOn(Date, "now").mockReturnValue(T0);

  assert.equal(await findDprint(), null);
  assert.equal(probes(), 1);

  // the wall clock steps back an hour: the failure is in the future, so it must not count as fresh
  clock.mockReturnValue(T0 - 3_600_000);
  assert.equal(await findDprint(), null);
  assert.equal(probes(), 2);

  // 31 s later the cached failure of the new stamp has expired, so it probes again
  clock.mockReturnValue(T0 - 3_600_000 + RETRY_MS + 1_000);
  assert.equal(await findDprint(), null);
  assert.equal(probes(), 3);
});
