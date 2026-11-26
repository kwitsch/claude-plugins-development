import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { test } from "vitest";

const FIXTURE = path.join(import.meta.dirname, "fixtures", "echo-server.ts");
const MODERN = { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } };

type Msg = { id?: number; result?: Record<string, unknown>; error?: { code: number; message: string; data?: unknown } };
/** A tool entry of `tools/list`. */
type ListedTool = { name: string; _meta: unknown; inputSchema: unknown };
/** The tools of a `tools/list` result. */
const toolsOf = (r: Msg["result"]): ListedTool[] => (r?.["tools"] ?? []) as ListedTool[];

/** A running fixture server: send JSON-RPC lines, wait for the answer of an id, end stdin. */
function start() {
  const child = spawn(process.execPath, [FIXTURE], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
  const answers: Msg[] = [];
  let stderr = "";
  let buf = "";
  child.stdout.on("data", (d: Buffer) => {
    buf += d.toString();
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      answers.push(JSON.parse(buf.slice(0, i)) as Msg);
      buf = buf.slice(i + 1);
    }
  });
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
  const exited = new Promise<number | null>((resolve) => child.on("close", resolve));
  const until = async (ok: () => boolean, what: string): Promise<void> => {
    for (let i = 0; i < 400 && !ok(); i++) await new Promise((r) => setTimeout(r, 25));
    assert.ok(ok(), `timed out waiting for ${what}; stderr: ${stderr}`);
  };
  return {
    send: (msg: object) => child.stdin.write(JSON.stringify(msg) + "\n"),
    raw: (text: string) => child.stdin.write(text + "\n"),
    answer: async (id: number): Promise<Msg> => {
      await until(() => answers.some((a) => a.id === id), `answer ${id}`);
      return answers.find((a) => a.id === id) as Msg;
    },
    answers: () => answers,
    stderr: () => stderr,
    waitStderr: (text: string) => until(() => stderr.includes(text), `stderr ${text}`),
    end: async () => {
      child.stdin.end();
      return exited;
    },
  };
}

test("initialize answers the 2025 era with the server's own version, never the client's", async () => {
  const s = start();
  s.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01" } });
  const r = (await s.answer(1)).result;
  assert.deepEqual(r, { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "fixture-hooks", version: "9.8.7" } });
  await s.end();
});

test("server/discover answers the 2026 era: resultType, cache hint, supported version, serverInfo meta", async () => {
  const s = start();
  s.send({ jsonrpc: "2.0", id: 1, method: "server/discover", params: MODERN });
  const r = (await s.answer(1)).result;
  assert.equal(r?.resultType, "complete");
  assert.equal(r?.ttlMs, 3_600_000);
  assert.equal(r?.cacheScope, "public");
  assert.deepEqual(r?.supportedVersions, ["2026-07-28"]);
  assert.deepEqual(r?.capabilities, { tools: {} });
  assert.deepEqual(r?._meta, { "io.modelcontextprotocol/serverInfo": { name: "fixture-hooks", version: "9.8.7" } });
  await s.end();
});

test("a request naming another protocol version is refused with -32022 and the supported list", async () => {
  const s = start();
  s.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2025-11-25" } } });
  const e = (await s.answer(1)).error;
  assert.equal(e?.code, -32022);
  assert.deepEqual(e?.data, { supported: ["2026-07-28"], requested: "2025-11-25" });
  await s.end();
});

test("tools/list: every tool is hook-only (ui.visibility app) with an any-object schema; modern adds resultType, cache hint and serverInfo meta, legacy adds none", async () => {
  const s = start();
  s.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  s.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: MODERN });
  const legacy = (await s.answer(1)).result;
  const modern = (await s.answer(2)).result;
  assert.deepEqual(toolsOf(legacy).map((t) => t.name), ["echo", "boom", "bigint", "watch", "slow"]);
  for (const t of toolsOf(legacy)) {
    assert.deepEqual(t._meta, { ui: { visibility: ["app"] } }, t.name);
    assert.deepEqual(t.inputSchema, { type: "object", additionalProperties: true }, t.name);
  }
  assert.equal(legacy?.resultType, undefined);
  assert.equal(legacy?.ttlMs, undefined);
  assert.equal(legacy?._meta, undefined);
  assert.equal(modern?.resultType, "complete");
  assert.equal(modern?.cacheScope, "public");
  assert.ok((modern?.["_meta"] as Record<string, unknown> | undefined)?.["io.modelcontextprotocol/serverInfo"]);
  await s.end();
});

test("tools/call answers text content and structuredContent with the same JSON; the modern call also gets resultType and no cache hint", async () => {
  const s = start();
  s.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo", arguments: { a: 1 } } });
  s.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo", ...MODERN } });
  const legacy = (await s.answer(1)).result;
  assert.deepEqual(legacy?.structuredContent, { echo: { a: 1 } });
  assert.deepEqual(legacy?.content, [{ type: "text", text: JSON.stringify({ echo: { a: 1 } }) }]);
  assert.equal(legacy?.resultType, undefined);
  const modern = (await s.answer(2)).result;
  assert.equal(modern?.resultType, "complete");
  assert.equal(modern?.ttlMs, undefined, "a call result is not list-like: no cache hint");
  assert.deepEqual(modern?.structuredContent, { echo: {} }, "missing arguments become {}");
  await s.end();
});

test("tools/call rejects an unknown tool (also an inherited name) and non-object arguments with -32602", async () => {
  const s = start();
  s.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "nope" } });
  s.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "toString" } });
  s.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "echo", arguments: [1] } });
  s.send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "echo", arguments: null } });
  s.send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: 7 } });
  for (const id of [1, 2, 3, 5]) assert.equal((await s.answer(id)).error?.code, -32602, `id ${id}`);
  assert.deepEqual((await s.answer(4)).result?.structuredContent, { echo: {} }, "null arguments count as missing (`??`), like the old servers");
  assert.match((await s.answer(2)).error?.message ?? "", /unknown tool/);
  assert.match((await s.answer(3)).error?.message ?? "", /arguments must be an object/);
  await s.end();
});

test("a throwing handler answers -32603 with its message and the server keeps serving", async () => {
  const s = start();
  s.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "boom" } });
  const e = (await s.answer(1)).error;
  assert.equal(e?.code, -32603);
  assert.match(e?.message ?? "", /kaput/);
  s.send({ jsonrpc: "2.0", id: 2, method: "ping" });
  assert.deepEqual((await s.answer(2)).result, {});
  await s.end();
});

test("ping, an unknown method (-32601) and notifications: a notification never gets an answer", async () => {
  const s = start();
  s.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  s.send({ jsonrpc: "2.0", method: "nope/unknown" });
  s.send({ jsonrpc: "2.0", id: 1, method: "nope/unknown" });
  s.send({ jsonrpc: "2.0", id: 2, method: "ping", params: MODERN });
  assert.equal((await s.answer(1)).error?.code, -32601);
  assert.deepEqual((await s.answer(2)).result, { resultType: "complete" });
  assert.equal(s.answers().length, 2, "no answer for the two notifications");
  await s.end();
});

test("a cancelled call stops being waited for: its handler gets the abort, no answer is sent, one stderr line says so; a cancel for an unknown id is ignored", async () => {
  const s = start();
  s.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "slow" } });
  s.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 99 } });
  s.send({ jsonrpc: "2.0", id: 2, method: "ping" });
  await s.answer(2);
  assert.equal(s.answers().some((a) => a.id === 1), false, "a cancel for another id does not touch call 1");
  s.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } });
  await s.waitStderr("cancelled tools/call 1 (slow)");
  await s.waitStderr("fixture: slow saw abort");
  s.send({ jsonrpc: "2.0", id: 3, method: "ping" });
  await s.answer(3);
  assert.equal(s.answers().some((a) => a.id === 1), false, "the cancelled call gets no answer, not even later");
  await s.end();
});

test("bad input lines are logged and ignored; a request after them is still served", async () => {
  const s = start();
  s.raw("not json");
  s.raw("[1,2]");
  s.raw("   ");
  s.send({ jsonrpc: "2.0", id: 1, method: "ping" });
  assert.deepEqual((await s.answer(1)).result, {});
  assert.match(s.stderr(), /non-JSON line ignored/);
  assert.match(s.stderr(), /non-object message ignored/);
  await s.end();
});

test("closing stdin runs onClose and exits 0", async () => {
  const s = start();
  s.send({ jsonrpc: "2.0", id: 1, method: "ping" });
  await s.answer(1);
  assert.equal(await s.end(), 0);
  assert.match(s.stderr(), /fixture: closed/);
  assert.match(s.stderr(), /\[fixture-hooks\] running \(v9\.8\.7\)/);
});

test("server/discover is modern without any _meta (the method alone decides)", async () => {
  const s = start();
  s.send({ jsonrpc: "2.0", id: 1, method: "server/discover" });
  assert.equal((await s.answer(1)).result?.["resultType"], "complete");
  await s.end();
});

test("a request without an id gets no answer even when it succeeds (ping, tools/call)", async () => {
  const s = start();
  s.send({ jsonrpc: "2.0", method: "ping" });
  s.send({ jsonrpc: "2.0", method: "tools/call", params: { name: "echo" } });
  s.send({ jsonrpc: "2.0", id: 1, method: "ping" });
  await s.answer(1);
  assert.equal(s.answers().length, 1);
  await s.end();
});

test("a failure of the loop itself (a result that cannot be serialized) is answered -32603 internal error, and the server keeps serving", async () => {
  const s = start();
  s.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "bigint" } });
  const e = (await s.answer(1)).error;
  assert.equal(e?.code, -32603);
  assert.match(e?.message ?? "", /internal error/);
  assert.match(s.stderr(), /handler crash/);
  s.send({ jsonrpc: "2.0", id: 2, method: "ping" });
  await s.answer(2);
  await s.end();
});

test("a cancel that arrives after the call finished is ignored: the finished call's signal is not aborted", async () => {
  const s = start();
  s.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "watch" } });
  await s.answer(1);
  s.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } });
  s.send({ jsonrpc: "2.0", id: 2, method: "ping" });
  await s.answer(2);
  assert.doesNotMatch(s.stderr(), /late abort/);
  await s.end();
});

test("tools/list: a tool with modelVisible and inputSchema lists them; a tool without keeps the two literals", async () => {
  const child = spawn(process.execPath, [path.join(import.meta.dirname, "fixtures", "visible-server.ts")], { stdio: ["pipe", "pipe", "ignore"], env: process.env });
  let buf = "";
  const line = new Promise<string>((resolve) => child.stdout.on("data", (d: Buffer) => ((buf += d.toString()), buf.includes("\n") && resolve(buf.slice(0, buf.indexOf("\n"))))));
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n");
  const tools = toolsOf((JSON.parse(await line) as Msg).result);
  child.stdin.end();
  assert.deepEqual(tools.map((t) => t.name), ["open", "hidden"]);
  assert.deepEqual(tools[0]._meta, { ui: { visibility: ["model", "app"] } });
  assert.deepEqual(tools[0].inputSchema, { type: "object", properties: { a: { type: "string" } }, required: ["a"] });
  assert.deepEqual(tools[1]._meta, { ui: { visibility: ["app"] } });
  assert.deepEqual(tools[1].inputSchema, { type: "object", additionalProperties: true });
});
