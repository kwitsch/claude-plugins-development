// Tests of the jev-api MCP server (plugin/mcp/server.mjs): a spawned stdio server against a local HTTP stub.
import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, describe, test } from "vitest";

const SERVER = path.resolve(import.meta.dirname, "../plugin/mcp/server.mjs");
const KEY = "test-key-123456";
const MODERN = "2026-07-28";
const META = { "io.modelcontextprotocol/protocolVersion": MODERN, "io.modelcontextprotocol/clientInfo": { name: "test", version: "0" }, "io.modelcontextprotocol/clientCapabilities": {} };

// The messages are untyped JSON-RPC: any keeps the assertions readable (the test file is relaxed, but this rule is not).
// oxlint-disable-next-line typescript/no-explicit-any -- untyped JSON-RPC test messages
type Msg = Record<string, any>;
// oxlint-disable-next-line typescript/no-explicit-any -- untyped JSON-RPC test messages
type Outcome = Record<string, any>;

/** A local stand-in for System One: behaviour per test, and a record of requests that were cut off. */
type Stub = { url: string; seen: Msg[]; aborted: number; set(b: { status?: number; body?: string; delayMs?: number }): void; arrived(n: number): Promise<void>; close(): Promise<void> };

const stub = async (): Promise<Stub> => {
  let behaviour: { status: number; body: string; delayMs: number } = { status: 200, body: "{\"answers\":{}}", delayMs: 0 };
  const seen: Msg[] = [];
  let aborted = 0;
  const waiters: { n: number; resolve: () => void }[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += String(c)));
    req.on("end", () => {
      seen.push({ headers: req.headers, body: raw });
      for (const w of waiters.filter((x) => seen.length >= x.n)) w.resolve();
      const timer = setTimeout(() => {
        res.writeHead(behaviour.status, { "Content-Type": "application/json" });
        res.end(behaviour.body);
      }, behaviour.delayMs);
      res.on("close", () => {
        if (!res.writableFinished) {
          aborted++;
          clearTimeout(timer);
        }
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port; // listening: an object
  return {
    url: `http://127.0.0.1:${port}/v1/systemone`,
    seen,
    get aborted() {
      return aborted;
    },
    set: (b) => {
      behaviour = { ...behaviour, ...b };
    },
    arrived: (n) => (seen.length >= n ? Promise.resolve() : new Promise<void>((resolve) => waiters.push({ n, resolve }))),
    close: () => new Promise<void>((resolve) => (server.closeAllConnections(), server.close(() => resolve()))),
  };
};

/** A spawned server speaking newline JSON-RPC; every stdout line is parsed and kept. */
const start = (env: Record<string, string>) => {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [SERVER], { env: { PATH: process.env["PATH"] ?? "", ...env }, stdio: ["pipe", "pipe", "pipe"] });
  const lines: string[] = [];
  const waiting = new Map<number | string, (m: Msg) => void>();
  const got = new Map<number | string, Msg>();
  let buf = "";
  child.stdout.on("data", (c) => {
    buf += String(c);
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      lines.push(line);
      const m = JSON.parse(line) as Msg;
      if (m["id"] !== undefined) {
        got.set(m["id"], m);
        waiting.get(m["id"])?.(m);
      }
    }
  });
  let next = 1;
  const send = (m: Msg) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
  const rpc = (method: string, params: Msg = {}, id: number = next++): Promise<Msg> => {
    send({ id, method, params });
    return new Promise((resolve) => (got.has(id) ? resolve(got.get(id) as Msg) : waiting.set(id, resolve)));
  };
  const call = async (name: string, args: Msg, modern = false): Promise<Msg> => rpc("tools/call", { name, arguments: args, ...(modern ? { _meta: META } : {}) });
  const request = (over: Msg = {}, id?: number): Promise<Msg> => rpc("tools/call", { name: "request", arguments: { callId: "c1", state: "A cat.", questions: { answer: { type: "noul", instructions: "q?" } }, timeoutMs: 5000, ...over } }, id);
  return { child, lines, send, rpc, call, request, pending: (id: number) => !got.has(id) };
};

const live: { child: ChildProcessWithoutNullStreams }[] = [];
const stubs: Stub[] = [];
afterEach(async () => {
  for (const s of live.splice(0)) s.child.kill("SIGKILL");
  for (const s of stubs.splice(0)) await s.close();
});

const boot = async (extra: Record<string, string> = {}, behaviour: Parameters<Stub["set"]>[0] = {}) => {
  const s = await stub();
  s.set(behaviour);
  stubs.push(s);
  const c = start({ JEV_URL: s.url, TYPESAFE_API_KEY: KEY, ...extra });
  live.push(c);
  return { s, c };
};
const outcomeOf = (r: Msg): Outcome => r["result"].structuredContent as Outcome;

describe("protocol", () => {
  test("legacy handshake lists exactly request and cancel, visible to the model", async () => {
    const { c } = await boot();
    const init = await c.rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    assert.equal(init["result"].protocolVersion, "2025-11-25");
    assert.ok(init["result"].capabilities.tools);
    assert.equal(init["result"].capabilities.extensions, undefined);
    c.send({ method: "notifications/initialized" });
    const list = await c.rpc("tools/list");
    const tools = list["result"].tools as Msg[];
    assert.deepEqual(tools.map((t) => String(t["name"])).sort((a, b) => a.localeCompare(b)), ["cancel", "request"]);
    for (const t of tools) {
      assert.match(t["description"], /^Internal transport of the jev-api plugin; calls from the model are refused\./);
      assert.equal(t["_meta"]?.ui?.visibility, undefined); // a hidden tool is not callable by $.mcp.call
      assert.equal(t["inputSchema"].type, "object");
    }
    assert.equal(list["result"].resultType, undefined);
  });

  test("modern discover and tools/list carry the envelope fields", async () => {
    const { c } = await boot();
    const d = await c.rpc("server/discover", { _meta: META });
    assert.deepEqual(d["result"].supportedVersions, [MODERN]);
    assert.equal(d["result"].resultType, "complete");
    assert.equal(typeof d["result"].ttlMs, "number");
    assert.equal(d["result"].cacheScope, "public");
    assert.equal(d["result"]._meta["io.modelcontextprotocol/serverInfo"].name, "jev-api-http");
    const l = await c.rpc("tools/list", { _meta: META });
    assert.equal(l["result"].resultType, "complete");
    assert.equal(typeof l["result"].ttlMs, "number");
    assert.equal(l["result"].tools.length, 2);
  });

  test("an unsupported modern version answers -32022 and an unknown method -32601", async () => {
    const { c } = await boot();
    const bad = await c.rpc("tools/list", { _meta: { ...META, "io.modelcontextprotocol/protocolVersion": "1999-01-01" } });
    assert.equal(bad["error"].code, -32022);
    assert.deepEqual(bad["error"].data.supported, [MODERN]);
    assert.equal((await c.rpc("nope")).error.code, -32601);
  });

  test("stdout carries only JSON-RPC", async () => {
    const { c } = await boot();
    await c.rpc("initialize", {});
    await c.request();
    await c.call("cancel", { callId: "zzz" });
    for (const l of c.lines) assert.equal((JSON.parse(l) as Msg)["jsonrpc"], "2.0");
  });

  test("modern tools/call answers with resultType complete", async () => {
    const { c } = await boot();
    const r = await c.call("cancel", { callId: "abc" }, true);
    assert.equal(r["result"].resultType, "complete");
    assert.deepEqual(r["result"].structuredContent, { cancelled: false });
  });

  test("an unknown tool answers -32602", async () => {
    const { c } = await boot();
    assert.equal((await c.call("nope", {})).error.code, -32602);
  });
});

describe("request", () => {
  test("a 2xx answer comes back unchanged as an ok outcome, in structuredContent and in the text block", async () => {
    const { s, c } = await boot({}, { body: "{\"answers\":{\"answer\":{\"type\":\"noul\",\"noul\":0.9}},\"usage\":{\"input_tokens\":30}}" });
    const r = await c.request();
    assert.equal(r["result"].isError, false);
    const o = outcomeOf(r);
    assert.deepEqual(o, { kind: "ok", status: 200, text: "{\"answers\":{\"answer\":{\"type\":\"noul\",\"noul\":0.9}},\"usage\":{\"input_tokens\":30}}" });
    assert.deepEqual(JSON.parse(r["result"].content[0].text), o);
    const sent = JSON.parse(s.seen[0]["body"]) as Msg;
    assert.equal(sent["state"], "A cat.");
    assert.equal(sent["model"], "jev-latest");
    assert.equal(s.seen[0]["headers"]["authorization"], undefined); // http endpoint: no key in cleartext
  });

  test("an HTTP error gives the redacted reason and never the key or the URL", async () => {
    const { s, c } = await boot({}, { status: 500 });
    s.set({ body: JSON.stringify({ error: { message: `boom ${KEY} at ${s.url}` } }) });
    const o = outcomeOf(await c.request());
    assert.deepEqual(o, { kind: "http", status: 500, reason: "boom <TYPESAFE_API_KEY> at <JEV_URL>" });
  });

  test("a 400 context refusal arrives parsed", async () => {
    const body = JSON.stringify({ error: { code: 400, type: "exceed_context_size_error", message: "too big", n_prompt_tokens: 40025, n_ctx: 32768 } });
    const { c } = await boot({}, { status: 400, body });
    assert.deepEqual(outcomeOf(await c.request()), { kind: "http", status: 400, reason: "too big", refusal: { tokens: 40025, nctx: 32768 } });
  });

  test("a refused connection is an error outcome without the host, the port or the key", async () => {
    const c = start({ JEV_URL: "http://127.0.0.1:9/v1", TYPESAFE_API_KEY: KEY });
    live.push(c);
    const r = await c.request();
    assert.equal(r["result"].isError, true);
    const o = outcomeOf(r);
    assert.equal(o["kind"], "error");
    assert.equal(o["code"], "network");
    assert.doesNotMatch(JSON.stringify(r), new RegExp(`${KEY}|127\\.0\\.0\\.1`));
  });

  test("without any System One variable the server answers a config error", async () => {
    const c = start({});
    live.push(c);
    const r = await c.request();
    assert.equal(r["result"].isError, true);
    assert.deepEqual(outcomeOf(r), { kind: "error", code: "config", message: "no System One access configured: set TYPESAFE_API_KEY, TYPESAFE_BASE_URL or JEV_URL" });
  });

  test("blank variables count as unset", async () => {
    const c = start({ JEV_URL: "  ", TYPESAFE_API_KEY: "\t" });
    live.push(c);
    assert.equal(outcomeOf(await c.request())["code"], "config");
  });

  test("an invalid JEV_URL is a config error and sends nothing", async () => {
    const c = start({ JEV_URL: "ftp://x" });
    live.push(c);
    assert.deepEqual(outcomeOf(await c.request()), { kind: "error", code: "config", message: "JEV_URL must be an http(s) URL" });
  });

  const BAD: [string, Msg][] = [
    ["an empty callId", { callId: "" }],
    ["a callId of 65 characters", { callId: "a".repeat(65) }],
    ["a callId with a bad character", { callId: "a b" }],
    ["a callId that is no string", { callId: 5 }],
    ["an empty state", { state: "" }],
    ["a state that is no string", { state: 5 }],
    ["questions that are no object", { questions: "q" }],
    ["questions that are an array", { questions: [] }],
    ["questions that are null", { questions: null }],
    ["timeoutMs 0", { timeoutMs: 0 }],
    ["timeoutMs 30001", { timeoutMs: 30001 }],
    ["timeoutMs 1.5", { timeoutMs: 1.5 }],
    ["a timeoutMs that is a string", { timeoutMs: "5000" }],
    ["a missing timeoutMs", { timeoutMs: undefined }],
  ];
  for (const [name, over] of BAD) {
    test(`${name} is an error and reaches no endpoint`, async () => {
      const { s, c } = await boot();
      const r = await c.request(over);
      assert.equal(r["result"].isError, true);
      assert.match(r["result"].content[0].text, /^request: /);
      assert.equal(s.seen.length, 0);
    });
  }

  test("the boundary timeoutMs values 1 and 30000 are valid", async () => {
    const { c } = await boot();
    assert.equal(outcomeOf(await c.request({ timeoutMs: 30000 }))["kind"], "ok");
    const one = outcomeOf(await c.request({ timeoutMs: 1, callId: "c2" }));
    assert.ok(one["kind"] === "ok" || one["code"] === "timeout"); // 1 ms may or may not win against a local stub
  });

  test("a response over 1 MiB is a network error", async () => {
    const { c } = await boot({}, { body: "x".repeat(1_100_000) });
    const o = outcomeOf(await c.request());
    assert.deepEqual(o, { kind: "error", code: "network", message: "response too large" });
  });

  test("two requests run at the same time", async () => {
    const { s, c } = await boot({}, { delayMs: 300 });
    const [a, b] = await Promise.all([c.request({ callId: "a" }), c.request({ callId: "b" })]);
    assert.equal(outcomeOf(a)["kind"], "ok");
    assert.equal(outcomeOf(b)["kind"], "ok");
    assert.equal(s.seen.length, 2);
  });
});

describe("timeout and cancel", () => {
  /** Waits until the stub saw its n-th connection closed early. */
  const closed = async (s: Stub, n: number) => {
    for (let i = 0; i < 400 && s.aborted < n; i++) await new Promise((r) => setTimeout(r, 20));
    return s.aborted;
  };

  test("a request slower than timeoutMs ends as a timeout and the connection is closed", async () => {
    const { s, c } = await boot({}, { delayMs: 5000 });
    const t = Date.now();
    const r = await c.request({ timeoutMs: 300 });
    assert.ok(Date.now() - t < 4500, "ended long before the stub answered");
    assert.equal(r["result"].isError, true);
    const o = outcomeOf(r);
    assert.equal(o["kind"], "error");
    assert.equal(o["code"], "timeout");
    assert.equal(o["message"], "timeout after 300ms");
    assert.equal(await closed(s, 1), 1);
  });

  test("cancel aborts a waiting request: the connection closes, the request answers aborted, cancel answers true", async () => {
    const { s, c } = await boot({}, { delayMs: 5000 });
    const pending = c.request({ timeoutMs: 20000, callId: "x1" });
    await s.arrived(1);
    const cancelled = await c.call("cancel", { callId: "x1" });
    assert.deepEqual(cancelled["result"].structuredContent, { cancelled: true });
    const o = outcomeOf(await pending);
    assert.deepEqual(o, { kind: "error", code: "aborted", message: "the call was abandoned" });
    assert.equal(await closed(s, 1), 1);
  });

  test("a second request with the id of a running one is refused and the first one is not disturbed", async () => {
    const { s, c } = await boot({}, { delayMs: 400 });
    const first = c.request({ callId: "dup" });
    await s.arrived(1);
    const second = await c.request({ callId: "dup" });
    assert.equal(second["result"].isError, true);
    assert.match(second["result"].content[0].text, /^request: callId is already in use/);
    assert.equal(outcomeOf(await first)["kind"], "ok");
    assert.equal(s.seen.length, 1);
  });

  test("cancel of an unknown or finished id answers false", async () => {
    const { c } = await boot();
    assert.deepEqual((await c.call("cancel", { callId: "never" }))["result"].structuredContent, { cancelled: false });
    await c.request({ callId: "done" });
    assert.deepEqual((await c.call("cancel", { callId: "done" }))["result"].structuredContent, { cancelled: false });
  });

  test("cancel validates its callId", async () => {
    const { c } = await boot();
    for (const callId of ["", "a b", 5, "z".repeat(65)]) {
      const r = await c.call("cancel", { callId });
      assert.equal(r["result"].isError, true);
    }
  });

  test("a cancel that arrives first makes the request answer aborted without reaching the endpoint", async () => {
    const { s, c } = await boot();
    await c.call("cancel", { callId: "early" });
    const o = outcomeOf(await c.request({ callId: "early" }));
    assert.equal(o["code"], "aborted");
    assert.equal(s.seen.length, 0);
    // the tombstone is consumed: the same id works again
    assert.equal(outcomeOf(await c.request({ callId: "early" }))["kind"], "ok");
  });

  test("a remembered cancel expires", async () => {
    const { s, c } = await boot({ JEV_API_TOMBSTONE_MS: "1" });
    await c.call("cancel", { callId: "old" });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(outcomeOf(await c.request({ callId: "old" }))["kind"], "ok");
    assert.equal(s.seen.length, 1);
  });

  test("at most 256 cancels are remembered", async () => {
    const { s, c } = await boot();
    for (let i = 0; i < 300; i++) c.send({ id: 1000 + i, method: "tools/call", params: { name: "cancel", arguments: { callId: `t${i}` } } });
    await c.call("cancel", { callId: "t-last" });
    assert.equal(outcomeOf(await c.request({ callId: "t-last" }))["code"], "aborted"); // newest is kept
    assert.equal(outcomeOf(await c.request({ callId: "t0" }))["kind"], "ok"); // oldest was evicted
    assert.equal(s.seen.length, 1);
  });

  test("notifications/cancelled aborts the request with that JSON-RPC id and sends no answer for it", async () => {
    const { s, c } = await boot({}, { delayMs: 5000 });
    const id = 777;
    void c.request({ timeoutMs: 20000, callId: "n1" }, id);
    await s.arrived(1);
    c.send({ method: "notifications/cancelled", params: { requestId: id, reason: "test" } });
    assert.equal(await closed(s, 1), 1);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(c.pending(id), true, "no answer was written for the cancelled call");
    // the server is still alive and answers the next call
    assert.equal(outcomeOf(await c.call("cancel", { callId: "q" }))["cancelled"], false);
  });

  test("a notification for an unknown id is ignored", async () => {
    const { c } = await boot();
    c.send({ method: "notifications/cancelled", params: { requestId: 99999 } });
    assert.equal(outcomeOf(await c.call("cancel", { callId: "q" }))["cancelled"], false);
  });
});
