// spawnGroup: detached process-group spawn with its own timeout, SIGTERM->SIGKILL escalation and per-stream cap (F18).
import assert from "node:assert/strict";
import type { SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "vitest";
import { spawnGroup } from "../src/hooks/lint-core.ts";
import { makeEnv, payload, waitGone } from "./support/lint-hook.ts";

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

test("spawnGroup: a pipe holder outside the group (setsid) cannot keep the promise pending: it settles after the kill sequence, the holder still alive", async () => {
  const e = makeEnv();
  const pidfile = path.join(e.cwd, "holder.pid");
  // the stub exits at once; `setsid sleep` leaves the group (its own session) and keeps the inherited stdout and stderr open
  e.stub("holder", `setsid sleep 30 & echo $! > "${pidfile}"`, "exit 0");
  const r = await spawnGroup(path.join(e.bin, "holder"), [], opts(e.cwd, 300));
  const pid = Number(readFileSync(pidfile, "utf8"));
  try {
    assert.equal(codeOf(r.error), "ETIMEDOUT");
    assert.equal(r.signal, "SIGKILL");
    assert.equal(r.status, null);
    assert.ok(pid > 0);
    process.kill(pid, 0); // throws when the holder is gone: the promise did not wait for it to exit
  } finally {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}, 10_000);

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

test("server: SIGTERM to the server kills its live linter groups before it exits (F18)", async () => {
  const e = makeEnv();
  const pidfile = path.join(e.cwd, "sleep.pid");
  // node, not sleep: the server's PATH holds only bash/node/git, so a `sleep` stub would exit at once and prove nothing.
  e.stub("shellcheck", `node -e "setTimeout(() => {}, 30000)" & echo $! > "${pidfile}"`, "wait");
  const f = e.file("a.sh", "#!/bin/sh\necho hi\n");
  const srv = e.server();
  // not awaited: the call never answers once the server is killed
  void srv.call("file_edited", { ...(JSON.parse(payload(f, e.cwd)) as Record<string, unknown>), session_id: "s1", key: await srv.key("s1") }).catch(() => undefined); // the test SIGTERMs the server: this call is never answered
  const until = Date.now() + 5000;
  while (!existsSync(pidfile) || readFileSync(pidfile, "utf8").trim() === "") {
    assert.ok(Date.now() < until, "the shellcheck stub never started");
    await sleep(50);
  }
  const pid = Number(readFileSync(pidfile, "utf8"));
  assert.ok(srv.pid !== undefined, "the server started");
  process.kill(srv.pid, "SIGTERM");
  // stdin stays open: the signal handler alone ends the server and kills the group (the stdin EOF path has its own test, delivery.test.ts)
  assert.ok(await waitGone(srv.pid, 5000), "the server exited on SIGTERM");
  assert.ok(await waitGone(pid, 2000), `forked sleep ${pid} survived the server's SIGTERM`);
}, 15_000);
