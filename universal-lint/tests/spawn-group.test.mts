// spawnGroup: detached process-group spawn with its own timeout, SIGTERM->SIGKILL escalation and per-stream cap (F18).
import assert from "node:assert/strict";
import type { SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "vitest";
import { spawnGroup } from "../plugin/hooks/lint-file.mjs";
import { makeEnv } from "./support/lint-hook.mts";

/**
 * Options as `buildSpawnOpts` builds them, with a test-chosen timeout (the F18 test seam).
 *
 * @param cwd - Child cwd.
 * @param timeout - Timeout in ms.
 * @returns The options.
 */
function opts(cwd: string, timeout: number): SpawnSyncOptionsWithStringEncoding {
  return { cwd, timeout, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 10 * 1024 * 1024 };
}

/**
 * Poll `kill(pid, 0)` until it throws (ESRCH: the process is gone) or `ms` elapsed.
 *
 * @param pid - The pid to watch.
 * @param ms - How long to poll.
 * @returns True when the process is gone.
 */
export async function waitGone(pid: number, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    if (Date.now() >= until) return false;
    await sleep(50);
  }
}

/**
 * The `code` of a spawn result's error.
 *
 * @param error - The result's error.
 * @returns Its code, or undefined.
 */
const codeOf = (error: NodeJS.ErrnoException | undefined): string | undefined => error?.code;

test("spawnGroup: a timeout kills the whole process group and reports ETIMEDOUT (F18)", async () => {
  const e = makeEnv();
  const pidfile = path.join(e.cwd, "sleep.pid");
  e.stub("forker", `sleep 30 & echo $! > "${pidfile}"`, "wait");
  const r = await spawnGroup(path.join(e.bin, "forker"), [], opts(e.cwd, 300));
  assert.equal(codeOf(r.error), "ETIMEDOUT");
  assert.equal(r.signal, "SIGTERM");
  assert.equal(r.status, null);
  const pid = Number(readFileSync(pidfile, "utf8"));
  assert.ok(pid > 0, "the stub did not record the forked sleep's pid");
  assert.ok(await waitGone(pid, 2000), `forked sleep ${pid} survived the group kill`);
}, 10_000);

test("spawnGroup: a child trapping SIGTERM is SIGKILLed after the grace and still reports ETIMEDOUT (F18)", async () => {
  const e = makeEnv();
  e.stub("trapper", "trap '' TERM", "sleep 30");
  const r = await spawnGroup(path.join(e.bin, "trapper"), [], opts(e.cwd, 300));
  assert.equal(codeOf(r.error), "ETIMEDOUT");
  assert.equal(r.signal, "SIGKILL");
});

test("spawnGroup: a missing bin reports ENOENT with no output (F18)", async () => {
  const e = makeEnv();
  const r = await spawnGroup("/nonexistent", [], opts(e.cwd, 1000));
  assert.equal(codeOf(r.error), "ENOENT");
  assert.equal(r.status, null);
  assert.equal(r.signal, null);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr, "");
});

test("spawnGroup: output above MAX_BUFFER_BYTES kills the child and reports ENOBUFS (F18)", async () => {
  const e = makeEnv();
  e.stub("spewer", "head -c 11000000 /dev/zero");
  const r = await spawnGroup(path.join(e.bin, "spewer"), [], opts(e.cwd, 10000));
  assert.equal(codeOf(r.error), "ENOBUFS");
});

test("spawnGroup: a normal exit carries status, stdout and stderr and no error (F18)", async () => {
  const e = makeEnv();
  e.stub("echoer", "echo out", "echo err >&2", "exit 3");
  const r = await spawnGroup(path.join(e.bin, "echoer"), [], opts(e.cwd, 5000));
  assert.equal(r.error, undefined);
  assert.equal(r.signal, null);
  assert.equal(r.status, 3);
  assert.equal(r.stdout, "out\n");
  assert.equal(r.stderr, "err\n");
});
