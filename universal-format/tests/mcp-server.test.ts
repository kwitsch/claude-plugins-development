// The MCP envelope of the spawned server in both protocol eras (repo rule `.claude/rules/mcp-dual-era.md`), its
// startup line and its cancellation.
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, test } from "vitest";
import { cleanup, PLUGIN, sandbox } from "./support/mcp.ts";

afterEach(cleanup);

const VERSION = (JSON.parse(readFileSync(path.join(PLUGIN, ".claude-plugin/plugin.json"), "utf8")) as { version: string }).version;
const SERVER_INFO = { name: "universal-format-hooks", version: VERSION };
/** The `_meta` envelope every 2026-07-28 request carries. */
const MODERN_META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "test", version: "0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

test("initialize reports universal-format-hooks with the manifest version and a version the server supports, never the client's", async () => {
  const s = sandbox().server();
  for (const protocolVersion of ["2025-11-25", "2024-11-05", undefined]) {
    assert.deepEqual((await s.rpc("initialize", { protocolVersion, capabilities: {}, clientInfo: { name: "test", version: "0" } })).result, {
      protocolVersion: "2025-11-25",
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
  }
});

test("tools/list lists format_pre as the only tool, hidden from the model", async () => {
  const list = (await sandbox().server().rpc("tools/list", {})).result;
  assert.deepEqual(list.tools.map((t) => t.name), ["format_pre"]);
  // hook-only: no model visibility, so ToolSearch never lists it while the mcp_tool hook still calls it
  assert.deepEqual(list.tools[0]._meta, { ui: { visibility: ["app"] } });
});

test("the startup line on stderr carries the manifest version; stdin EOF ends the server with exit 0", async () => {
  const s = sandbox().server();
  await s.rpc("ping", {});
  assert.ok(s.stderr().includes(`[universal-format-hooks] running (v${VERSION})`), s.stderr());
  s.child.stdin.end();
  assert.deepEqual(await once(s.child, "close"), [0, null]);
});

test("2026-07-28: server/discover answers without initialize and names the versions, capabilities and serverInfo", async () => {
  const r = (await sandbox().server().rpc("server/discover", { _meta: MODERN_META })).result;
  assert.equal(r.resultType, "complete");
  assert.deepEqual(r.supportedVersions, ["2026-07-28"]);
  assert.deepEqual(r.capabilities, { tools: {} });
  assert.deepEqual(r._meta, { "io.modelcontextprotocol/serverInfo": SERVER_INFO });
  assert.equal(typeof r.ttlMs, "number");
  assert.equal(r.cacheScope, "public");
});

test("2026-07-28: tools/list and tools/call carry the modern envelope, the handler result is the legacy one", async () => {
  const sb = sandbox();
  const s = sb.server();
  const legacy = (await s.rpc("tools/list", {})).result;
  assert.equal("resultType" in legacy, false);
  const list = (await s.rpc("tools/list", { _meta: MODERN_META })).result;
  assert.equal(list.resultType, "complete");
  assert.equal(typeof list.ttlMs, "number");
  assert.equal(list.cacheScope, "public");
  assert.deepEqual(list.tools, legacy.tools);
  const args = { cwd: sb.proj, tool_name: "Write", tool_input: { file_path: path.join(sb.proj, "a.json"), content: "{\"a\":1}" } };
  const modern = (await s.rpc("tools/call", { name: "format_pre", arguments: args, _meta: MODERN_META })).result;
  assert.equal(modern.resultType, "complete");
  assert.equal(modern.structuredContent.hookSpecificOutput.updatedInput.content, "{ \"a\": 1 }\n");
  assert.deepEqual(modern.structuredContent, await s.call(args));
  // the 2025-era text block holds the same JSON
  assert.deepEqual(JSON.parse((modern.content as { text: string }[])[0].text), modern.structuredContent);
});

test("2026-07-28: an unsupported version answers -32022 with the supported list; an unknown method -32601", async () => {
  const s = sandbox().server();
  const bad = (await s.rpc("tools/list", { _meta: { ...MODERN_META, "io.modelcontextprotocol/protocolVersion": "1900-01-01" } })).error;
  assert.equal(bad.code, -32022);
  assert.deepEqual(bad.data, { supported: ["2026-07-28"], requested: "1900-01-01" });
  assert.equal((await s.rpc("tools/list", { _meta: { ...MODERN_META, "io.modelcontextprotocol/protocolVersion": 20260728 } })).error.code, -32022);
  assert.equal((await s.rpc("resources/list", { _meta: MODERN_META })).error.code, -32601);
  assert.equal((await s.rpc("resources/list", {})).error.code, -32601);
  assert.equal((await s.rpc("ping", { _meta: MODERN_META })).result.resultType, "complete");
});

test("tools/call: an unknown tool and non-object arguments answer -32602", async () => {
  const s = sandbox().server();
  assert.equal((await s.rpc("tools/call", { name: "format_post", arguments: {} })).error.code, -32602);
  assert.equal((await s.rpc("tools/call", { name: "format_pre", arguments: [] })).error.code, -32602);
  // arguments the handler cannot use are no error: the hook fails open
  assert.deepEqual((await s.rpc("tools/call", { name: "format_pre" })).result.structuredContent, {});
  assert.deepEqual(await s.call({ cwd: 1, tool_name: "Write", tool_input: { file_path: {} } }), {});
});

test("a request without an id is a notification: no answer, in either era; a non-JSON line is ignored", async () => {
  const s = sandbox().server();
  s.raw({ method: "tools/list" });
  s.raw({ method: "tools/list", params: { _meta: MODERN_META } });
  s.child.stdin.write("not json\n[1]\n");
  // the next answer on stdout is the one to this ping: nothing was written for the messages before it
  assert.equal((await s.rpc("ping", {})).id, 1);
  assert.deepEqual([...s.answered], [1]);
});

test("notifications/cancelled stops waiting for the call, kills the formatter and sends no answer for it", async () => {
  const sb = sandbox();
  // a formatter that never answers: without the cancel the call would be in flight for 30 s
  sb.stub("gofmt", ["echo $$ > \"$RECORD\"", "cat >/dev/null", "exec node -e 'setTimeout(()=>{},60000)'"]);
  const s = sb.server();
  s.raw({ id: 99, method: "tools/call", params: { name: "format_pre", arguments: { cwd: sb.proj, tool_name: "Write", tool_input: { file_path: path.join(sb.proj, "a.go"), content: "package main" } } } });
  for (let i = 0; i < 100 && sb.recorded() === ""; i++) await new Promise((r) => setTimeout(r, 50));
  const pid = Number(sb.recorded());
  assert.ok(pid > 0, "the formatter must be running");
  s.raw({ method: "notifications/cancelled", params: { requestId: 99, reason: "test" } });
  await s.rpc("ping", {}); // the loop is alive and answers on
  for (let i = 0; i < 40 && !s.stderr().includes("cancelled tools/call 99"); i++) await new Promise((r) => setTimeout(r, 50));
  assert.match(s.stderr(), /cancelled tools\/call 99/);
  assert.equal(s.answered.has(99), false);
  let alive = true;
  for (let i = 0; i < 40 && alive; i++) {
    try {
      process.kill(pid, 0);
      await new Promise((r) => setTimeout(r, 50));
    } catch {
      alive = false;
    }
  }
  assert.equal(alive, false, "the cancelled call's formatter must be killed");
  // a cancel for an unknown or finished id is ignored
  s.raw({ method: "notifications/cancelled", params: { requestId: 12345 } });
  assert.deepEqual((await s.rpc("ping", {})).result, {});
});
