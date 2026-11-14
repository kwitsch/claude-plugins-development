// Tests of the MCP transport of the jev-api mod: the hooks driven directly with a hand-made `$` (the kit cannot abandon a dispatch).
import { describe, expect, it } from "vitest";

const TOOL = (type: string) => `mcp__jev-api__${type}`;
const SERVER = "plugin:jev-api:http";
const NOUL_ANSWER = { type: "noul", noul: 0.9 };
const OK_TEXT = JSON.stringify({ answers: { answer: NOUL_ANSWER }, usage: {} });
const BASE = { instructions: "Is this text about animals?", state: "A cat sat on the mat." };

type Args = Record<string, unknown>;
type McpResult = { isError: boolean; content: { type: string; text: string }[]; structuredContent?: unknown };
type Call = { server: string; tool: string; args: Args };

/** An MCP tool result carrying an outcome, the way the server answers. */
const outcome = (o: Args): McpResult => ({ isError: o["kind"] === "error", content: [{ type: "text", text: JSON.stringify(o) }], structuredContent: o });
const okOutcome = outcome({ kind: "ok", status: 200, text: OK_TEXT });

type Rig = Awaited<ReturnType<typeof rig>>;

/**
 * The module's hooks with a fake engine: recorded MCP calls, `http.fetch`, log lines, manual timers and clock.
 *
 * @param opts - `connect` answers `$.mcp.connect` (default: connected); `onCall` answers `$.mcp.call` (default: an ok outcome for `request`, `{cancelled:true}` for `cancel`); `noMcp` leaves `$.mcp` out like the older tests' world; `options` is the plugin's userConfig; `env` the env values.
 */
async function rig(opts: { connect?: () => Promise<unknown>; onCall?: (c: Call) => unknown; noMcp?: boolean; options?: Record<string, unknown>; env?: Record<string, string> } = {}) {
  const { register } = await import("../plugin/hooks/register.mjs");
  const hooks = new Map<string, (...a: unknown[]) => Promise<unknown>>();
  register((event: string, hook: (...a: unknown[]) => Promise<unknown>) => void hooks.set(event, hook), opts.options);
  const mcpCalls: Call[] = [];
  const fetched: { url: string; init: Args }[] = [];
  const logs: string[] = [];
  const timers: { ms: number; fn: () => void; cancelled: boolean }[] = [];
  const clock = { now: 1_000_000 };
  const connects = { n: 0 };
  const env = opts.env ?? { TYPESAFE_API_KEY: "k" };
  const $ = {
    env: { get: async (name: string) => env[name] },
    http: { fetch: (url: string, init: Args) => (fetched.push({ url, init }), Promise.resolve({ status: 200, ok: true, headers: {}, text: OK_TEXT })) },
    clock: {
      now: async () => clock.now,
      after: (ms: number, fn: () => void) => {
        const t = { ms, fn, cancelled: false };
        timers.push(t);
        return { cancel: () => void (t.cancelled = true) };
      },
    },
    ui: { log: (t: string) => void logs.push(t) },
    ...(opts.noMcp ? {} : {
      mcp: {
        connect: async () => (connects.n++, opts.connect ? opts.connect() : { isConnected: true, server: SERVER }),
        call: (server: string, tool: string, args: Args) => {
          const c = { server, tool, args };
          mcpCalls.push(c);
          if (opts.onCall) return Promise.resolve(opts.onCall(c));
          return Promise.resolve(tool === "cancel" ? { isError: false, content: [{ type: "text", text: "{\"cancelled\":true}" }], structuredContent: { cancelled: true } } : okOutcome);
        },
      },
    }),
  };
  const run = (type = "noul", input: Args = {}, signal: AbortSignal = new AbortController().signal) => hooks.get("tool.call")?.($, { tool: TOOL(type), ...BASE, ...input }, Object.assign(async () => ({}), { signal })) as Promise<{ result?: string; deny?: string }>;
  /** Runs every live timer of this length. */
  const fire = (ms: number) => timers.filter((t) => t.ms === ms && !t.cancelled).forEach((t) => t.fn());
  const requests = () => mcpCalls.filter((c) => c.tool === "request");
  const cancels = () => mcpCalls.filter((c) => c.tool === "cancel");
  /** Waits until n calls of a tool were made. */
  const until = async (tool: string, n: number) => {
    for (let i = 0; i < 200 && mcpCalls.filter((c) => c.tool === tool).length < n; i++) await new Promise((r) => setImmediate(r));
  };
  return { hooks, $, run, mcpCalls, fetched, logs, timers, clock, connects, fire, requests, cancels, until };
}

const NEVER = () => new Promise<never>(() => {});

/** The log lines about the transport server (the registration of the tools logs too in this world, where `$.tool` is missing). */
const outage = (t: Rig) => t.logs.filter((l) => l.startsWith("jev-api: HTTP server not available"));

describe("the request goes through the server", () => {
  it("sends one request call with callId, state, questions and timeoutMs, and no http.fetch", async () => {
    const t = await rig();
    const r = await t.run();
    expect(JSON.parse(r.result ?? "null")).toEqual(NOUL_ANSWER);
    expect(t.fetched).toHaveLength(0);
    expect(t.connects.n).toBe(1);
    expect(t.requests()).toHaveLength(1);
    const call = t.requests()[0];
    expect(call.server).toBe(SERVER);
    expect(call.args).toMatchObject({ state: BASE.state, timeoutMs: 20000, questions: { answer: { type: "noul", instructions: BASE.instructions } } });
    expect(call.args["callId"]).toMatch(/^[a-z0-9]+-\d+$/);
    expect(Object.keys(call.args).sort((a, b) => a.localeCompare(b))).toEqual(["callId", "questions", "state", "timeoutMs"]);
  });

  it("connects once and keeps the server for later calls", async () => {
    const t = await rig();
    await t.run();
    await t.run();
    expect(t.connects.n).toBe(1);
    expect(t.requests()).toHaveLength(2);
  });

  it("gives every call its own callId", async () => {
    const t = await rig();
    await Promise.all([t.run(), t.run(), t.run()]);
    const ids = t.requests().map((c) => c.args["callId"]);
    expect(new Set(ids).size).toBe(3);
  });

  it("answers batch and the other tools from the same transport", async () => {
    const t = await rig({ onCall: () => outcome({ kind: "ok", status: 200, text: JSON.stringify({ answers: { q0: NOUL_ANSWER, q1: NOUL_ANSWER } }) }) });
    const r = await t.run("batch", { state: "s", questions: [{ type: "noul", instructions: "a?" }, { type: "noul", instructions: "b?" }] });
    expect(JSON.parse(r.result ?? "null")).toEqual([NOUL_ANSWER, NOUL_ANSWER]);
    expect(t.requests()[0].args["questions"]).toEqual({ q0: { type: "noul", instructions: "a?" }, q1: { type: "noul", instructions: "b?" } });
  });

  for (
    const [what, input, option, expected] of [
      ["the call's timeout in seconds", { timeout: 4 }, undefined, 4000],
      ["the option when the call gives none", {}, 7, 7000],
      ["the call over the option", { timeout: 3 }, 7, 3000],
      ["30 s at most", { timeout: 99 }, undefined, 30000],
      ["20 s when nothing valid is given", { timeout: -1 }, undefined, 20000],
    ] as [string, Args, number | undefined, number][]
  ) {
    it(`timeoutMs is ${what}`, async () => {
      const t = await rig({ options: option === undefined ? undefined : { timeout: option } });
      await t.run("noul", input);
      expect(t.requests()[0].args["timeoutMs"]).toBe(expected);
    });
  }
});

describe("outcomes become the tool results of 0.4.0", () => {
  it("an http outcome with a reason", async () => {
    const t = await rig({ onCall: () => outcome({ kind: "http", status: 500, reason: "boom" }) });
    expect(await t.run()).toEqual({ deny: "noul: HTTP 500: boom" });
  });
  it("an http outcome without a reason", async () => {
    const t = await rig({ onCall: () => outcome({ kind: "http", status: 502 }) });
    expect(await t.run()).toEqual({ deny: "noul: HTTP 502" });
  });
  it("error outcomes keep their text", async () => {
    for (const [code, message] of [["timeout", "timeout after 4000ms"], ["aborted", "the call was abandoned"], ["network", "fetch failed"], ["config", "no System One access configured: set TYPESAFE_API_KEY, TYPESAFE_BASE_URL or JEV_URL"]]) {
      const t = await rig({ onCall: () => outcome({ kind: "error", code, message }) });
      expect(await t.run()).toEqual({ deny: `noul: ${message}` });
    }
  });
  it("an ok outcome with a wrong answer is the old response error", async () => {
    const t = await rig({ onCall: () => outcome({ kind: "ok", status: 200, text: "{\"answers\":{}}" }) });
    expect(await t.run()).toEqual({ deny: "noul: response had no noul answer" });
  });
  it("a context refusal is the translated refusal in error mode", async () => {
    const t = await rig({ onCall: () => outcome({ kind: "http", status: 400, reason: "too big", refusal: { tokens: 40025, nctx: 32768 } }) });
    const r = await t.run("noul", { overflow: "error" });
    expect(r.deny).toMatch(/^noul: state too large for System One: the request has 40025 tokens, the limit is 32767;/);
  });
  it("a context refusal in truncate mode sends one more, shorter request through the server", async () => {
    let n = 0;
    const t = await rig({ onCall: () => (n++ === 0 ? outcome({ kind: "http", status: 400, reason: "too big", refusal: { tokens: 40025, nctx: 32768 } }) : okOutcome) });
    const r = await t.run("noul", { overflow: "truncate", state: "x".repeat(2000) });
    expect(JSON.parse(r.result ?? "null")).toEqual(NOUL_ANSWER);
    expect(t.requests()).toHaveLength(2);
    expect(String(t.requests()[1].args["state"]).length).toBeLessThan(2000);
    expect(String(t.requests()[1].args["state"])).toContain("characters omitted");
    expect(t.fetched).toHaveLength(0);
  });
});

describe("timeout guard and abandonment", () => {
  it("the mod's own guard fires 1500 ms after timeoutMs, answers the timeout and cancels once", async () => {
    const t = await rig({ onCall: (c) => (c.tool === "request" ? NEVER() : { isError: false, content: [], structuredContent: { cancelled: true } }) });
    const pending = t.run();
    await t.until("request", 1);
    expect(t.timers.some((x) => x.ms === 21500 && !x.cancelled)).toBe(true);
    expect(t.timers.some((x) => x.ms === 21499)).toBe(false);
    t.fire(21500);
    expect(await pending).toEqual({ deny: "noul: timeout after 20000ms" });
    await t.until("cancel", 1);
    expect(t.cancels()).toHaveLength(1);
    expect(t.cancels()[0].server).toBe(SERVER);
    expect(t.cancels()[0].args).toEqual({ callId: t.requests()[0].args["callId"] });
  });

  it("an abandoned call answers at once and cancels exactly once with the same callId", async () => {
    const t = await rig({ onCall: (c) => (c.tool === "request" ? NEVER() : { isError: false, content: [], structuredContent: { cancelled: true } }) });
    const ctl = new AbortController();
    const pending = t.run("noul", {}, ctl.signal);
    await t.until("request", 1);
    ctl.abort();
    expect(await pending).toEqual({ deny: "noul: the call was abandoned" });
    await t.until("cancel", 1);
    expect(t.cancels()).toHaveLength(1);
    expect(t.cancels()[0].args).toEqual({ callId: t.requests()[0].args["callId"] });
    ctl.abort();
    t.fire(21500);
    await new Promise((r) => setImmediate(r));
    expect(t.cancels()).toHaveLength(1);
    expect(t.fetched).toHaveLength(0);
  });

  it("a settled call sends no cancel, also not when its signal aborts later or its guard fires", async () => {
    const t = await rig();
    const ctl = new AbortController();
    await t.run("noul", {}, ctl.signal);
    ctl.abort();
    t.fire(21500);
    await new Promise((r) => setImmediate(r));
    expect(t.cancels()).toHaveLength(0);
    expect(t.timers.filter((x) => x.ms === 21500).every((x) => x.cancelled)).toBe(true);
  });

  it("a failing cancel call never fails the answer", async () => {
    const t = await rig({ onCall: (c) => (c.tool === "request" ? NEVER() : Promise.reject(new Error("server gone"))) });
    const pending = t.run();
    await t.until("request", 1);
    t.fire(21500);
    expect(await pending).toEqual({ deny: "noul: timeout after 20000ms" });
  });
});

describe("fallback to $.http.fetch", () => {
  it("a server that is not connected is replaced by the fetch path, with one log line per outage", async () => {
    const t = await rig({ connect: async () => ({ isConnected: false, message: "spawn node ENOENT" }) });
    expect(JSON.parse((await t.run()).result ?? "null")).toEqual(NOUL_ANSWER);
    expect(JSON.parse((await t.run()).result ?? "null")).toEqual(NOUL_ANSWER);
    expect(t.fetched).toHaveLength(2);
    expect(t.requests()).toHaveLength(0);
    expect(outage(t)).toEqual(["jev-api: HTTP server not available, using $.http.fetch: spawn node ENOENT"]);
  });

  it("does not reconnect for 60 s, and does at 60 s", async () => {
    let up = false;
    const t = await rig({ connect: async () => (up ? { isConnected: true, server: SERVER } : { isConnected: false, message: "down" }) });
    await t.run();
    expect(t.connects.n).toBe(1);
    t.clock.now += 59_999;
    await t.run();
    expect(t.connects.n).toBe(1);
    up = true;
    t.clock.now += 1;
    await t.run();
    expect(t.connects.n).toBe(2);
    expect(t.requests()).toHaveLength(1);
    await t.run();
    expect(t.connects.n).toBe(2);
    expect(t.requests()).toHaveLength(2);
  });

  it("a connect that throws is the same outage", async () => {
    const t = await rig({
      connect: async () => {
        throw new Error("no such server");
      },
    });
    await t.run();
    expect(t.fetched).toHaveLength(1);
    expect(outage(t)[0]).toContain("no such server");
  });

  it("a connect that never answers is given up after 3 s", async () => {
    const t = await rig({ connect: NEVER });
    const pending = t.run();
    for (let i = 0; i < 100 && !t.timers.some((x) => x.ms === 3000); i++) await new Promise((r) => setImmediate(r));
    t.fire(3000);
    expect(JSON.parse((await pending).result ?? "null")).toEqual(NOUL_ANSWER);
    expect(t.fetched).toHaveLength(1);
  });

  it("a throwing request call falls back for that call, marks the link down and logs once", async () => {
    const t = await rig({ onCall: () => Promise.reject(new Error("transport closed")) });
    expect(JSON.parse((await t.run()).result ?? "null")).toEqual(NOUL_ANSWER);
    expect(t.fetched).toHaveLength(1);
    await t.run();
    expect(t.fetched).toHaveLength(2);
    expect(t.requests()).toHaveLength(1);
    expect(t.connects.n).toBe(1);
    expect(outage(t)).toHaveLength(1);
    expect(outage(t)[0]).toContain("transport closed");
  });

  it("a result that is neither an outcome nor an error text falls back, an error text is the answer", async () => {
    const garbage = await rig({ onCall: () => ({ isError: false, content: [{ type: "text", text: "hello" }] }) });
    expect(JSON.parse((await garbage.run()).result ?? "null")).toEqual(NOUL_ANSWER);
    expect(garbage.fetched).toHaveLength(1);
    const text = await rig({ onCall: () => ({ isError: true, content: [{ type: "text", text: "request: state must be a non-empty string" }] }) });
    expect(await text.run()).toEqual({ deny: "noul: request: state must be a non-empty string" });
    expect(text.fetched).toHaveLength(0);
  });

  it("without any mcp API (the older tests' world) the fetch path answers and nothing is logged about the server", async () => {
    const t = await rig({ noMcp: true });
    expect(JSON.parse((await t.run()).result ?? "null")).toEqual(NOUL_ANSWER);
    await t.run();
    expect(t.fetched).toHaveLength(2);
    expect(outage(t)).toHaveLength(0);
  });

  it("a call with no System One access (Haiku) never touches the server", async () => {
    const t = await rig({ env: {} });
    (t.$ as Record<string, unknown>)["model"] = { complete: async () => ({ isAnswered: true, text: JSON.stringify({ answers: { answer: NOUL_ANSWER } }), usage: {} }) };
    const r = await t.run();
    expect(JSON.parse(r.result ?? "null")).toMatchObject({ type: "noul" });
    expect(t.connects.n).toBe(0);
    expect(t.mcpCalls).toHaveLength(0);
  });
});

describe("tool.check keeps the model off the transport", () => {
  const check = async (t: Rig, tool: string, origin?: { plugin: string }) => {
    const next = Object.assign(async () => "passed", { origin });
    return t.hooks.get("tool.check")?.(t.$, { tool }, next);
  };
  it("allows the mod's own calls", async () => {
    const t = await rig();
    for (const tool of ["mcp__plugin_jev-api_http__request", "mcp__plugin_jev-api_http__cancel"]) {
      expect(await check(t, tool, { plugin: "jev-api" })).toMatchObject({ decision: "allow" });
    }
  });
  it("refuses every other origin, also a missing one", async () => {
    const t = await rig();
    for (const origin of [{ plugin: "engine" }, { plugin: "jevfort" }, undefined]) {
      const r = await check(t, "mcp__plugin_jev-api_http__request", origin);
      expect(r).toMatchObject({ decision: "deny" });
      expect(String((r as { reason: string }).reason)).toContain("mcp__jev-api__batch");
    }
  });
  it("leaves every other tool, also of a similar name, to the chain", async () => {
    const t = await rig();
    for (const tool of ["Bash", "mcp__jev-api__noul", "mcp__plugin_jev-api_http", "mcp__plugin_jev-api_httpx__request", "mcp__plugin_other_http__request"]) {
      expect(await check(t, tool, { plugin: "engine" })).toBe("passed");
    }
  });
});
