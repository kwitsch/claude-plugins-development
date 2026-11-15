// Tests of the MCP transport of the jev-api mod: the hooks driven directly with a hand-made `$` (the kit cannot abandon a dispatch).
import { readFileSync } from "node:fs";
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
async function rig(opts: { connect?: () => Promise<unknown>; onCall?: (c: Call) => unknown; noMcp?: boolean; onConfig?: (c: Call) => unknown; complete?: (r: Args) => unknown; store?: () => Promise<unknown>; register?: () => Promise<unknown>; options?: Record<string, unknown>; env?: Record<string, string> } = {}) {
  const { register } = await import("../plugin/hooks/register.mjs");
  const hooks = new Map<string, (...a: unknown[]) => Promise<unknown>>();
  register((event: string, hook: (...a: unknown[]) => Promise<unknown>) => void hooks.set(event, hook), opts.options);
  const mcpCalls: Call[] = [];
  const fetched: { url: string; init: Args }[] = [];
  const logs: string[] = [];
  const timers: { ms: number; fn: () => void; cancelled: boolean }[] = [];
  const clock = { now: 1_000_000 };
  const connects = { n: 0 };
  const completed: Args[] = [];
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
    model: { complete: (r: Args) => (completed.push(r), Promise.resolve(opts.complete ? opts.complete(r) : { isAnswered: false, reason: "unavailable" })) },
    ui: { log: (t: string) => void logs.push(t) },
    ...(opts.store ? { store: { get: opts.store, set: async () => undefined } } : {}),
    ...(opts.register ? { tool: { register: opts.register } } : {}),
    ...(opts.noMcp ? {} : {
      mcp: {
        connect: async () => (connects.n++, opts.connect ? opts.connect() : { isConnected: true, server: SERVER }),
        call: (server: string, tool: string, args: Args) => {
          const c = { server, tool, args };
          mcpCalls.push(c);
          if (tool === "config") return Promise.resolve(opts.onConfig ? opts.onConfig(c) : { isError: false, content: [{ type: "text", text: "{\"configured\":true}" }], structuredContent: { configured: true } });
          if (opts.onCall) return Promise.resolve(opts.onCall(c));
          return Promise.resolve(tool === "cancel" ? { isError: false, content: [{ type: "text", text: "{\"cancelled\":true}" }], structuredContent: { cancelled: true } } : okOutcome);
        },
      },
    }),
  };
  // an HTTP error is taken over by Haiku: the stub has none by default, its failure text is cut off
  const run = async (type = "noul", input: Args = {}, signal: AbortSignal = new AbortController().signal) => {
    const r = (await hooks.get("tool.call")?.($, { tool: TOOL(type), ...BASE, ...input }, Object.assign(async () => ({}), { signal }))) as { result?: string; deny?: string };
    return r.deny === undefined ? r : { ...r, deny: r.deny.replace("; fallback: unavailable", "") };
  };
  /** Runs every live timer of this length. */
  const fire = (ms: number) => timers.filter((t) => t.ms === ms && !t.cancelled).forEach((t) => t.fn());
  const requests = () => mcpCalls.filter((c) => c.tool === "request");
  const configs = () => mcpCalls.filter((c) => c.tool === "config");
  const cancels = () => mcpCalls.filter((c) => c.tool === "cancel");
  /** Waits until n calls of a tool were made. */
  const until = async (tool: string, n: number) => {
    for (let i = 0; i < 200 && mcpCalls.filter((c) => c.tool === tool).length < n; i++) await new Promise((r) => setImmediate(r));
  };
  return { hooks, $, run, mcpCalls, fetched, logs, timers, clock, connects, fire, requests, cancels, configs, completed, env, until };
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
    expect(Object.keys(call.args).sort((a, b) => a.localeCompare(b))).toEqual(["callId", "configGen", "questions", "state", "timeoutMs"]);
  });

  it("the request gets only the time the connect and the config call left, and none left is a timeout", async () => {
    for (const [used, expected] of [[2900, 1100], [4000, undefined]] as [number, number | undefined][]) {
      const t = await rig({ connect: async () => (t.clock.now += used / 2, { isConnected: true, server: SERVER }), onConfig: () => (t.clock.now += used / 2, outcome({ configured: true })) });
      const r = await t.run("noul", { timeout: 4 });
      if (expected === undefined) {
        expect(t.requests()).toHaveLength(0);
        expect(r.deny).toContain("timeout after 4000ms");
      } else expect(t.requests()[0].args["timeoutMs"]).toBe(expected);
    }
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
    expect(await t.run()).toEqual({ deny: "noul: response had no valid noul answer" });
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

  it("a dispatch abandoned while the call id is made sends no request", async () => {
    const t = await rig();
    await t.run(); // connects
    let release: (n: number) => void = () => undefined;
    let reads = 0; // the first read is the call's start time, the second the call id's
    (t.$.clock as { now: () => Promise<number> }).now = () => (++reads === 2 ? new Promise<number>((resolve) => (release = resolve)) : Promise.resolve(1_000_000));
    const ctl = new AbortController();
    const pending = t.run("noul", {}, ctl.signal);
    for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
    ctl.abort();
    release(1_000_000);
    expect(await pending).toEqual({ deny: "noul: the call was abandoned" });
    expect(t.requests()).toHaveLength(1);
    expect(t.cancels()).toHaveLength(0);
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

  it("an outage that outlasts the 60 s retry is logged once", async () => {
    const t = await rig({ connect: async () => ({ isConnected: false, message: "down" }) });
    await t.run();
    t.clock.now += 60_000;
    await t.run();
    expect(t.connects.n).toBe(2);
    expect(outage(t)).toHaveLength(1);
  });

  it("a second outage after a successful reconnect is logged again", async () => {
    let up = false;
    const t = await rig({
      connect: async () => (up ? { isConnected: true, server: SERVER } : { isConnected: false, message: "down" }),
      onCall: () => (up ? Promise.reject(new Error("transport closed")) : okOutcome),
    });
    await t.run();
    up = true;
    t.clock.now += 60_000;
    await t.run();
    expect(outage(t)).toHaveLength(2);
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

  it("a server that dies late leaves the fetch only the time that is left, or no fetch at all", async () => {
    for (const [used, left] of [[3900, 100], [4000, 0]]) {
      const t = await rig({
        onCall: (c) => {
          if (c.tool === "request") {
            t.clock.now += used;
            return Promise.reject(new Error("server exited"));
          }
          return undefined;
        },
      });
      const r = await t.run("noul", { timeout: 4 });
      if (left === 0) {
        expect(t.fetched).toHaveLength(0);
        expect(r.deny).toBe("noul: timeout after 4000ms");
      } else {
        expect(t.fetched).toHaveLength(1);
        expect(t.timers.filter((x) => x.ms === left)).toHaveLength(1);
        expect(t.timers.filter((x) => x.ms === 4000)).toHaveLength(0);
      }
    }
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

  it("a TypeError the connect call rejects with is an outage like any other: logged, tried again after 60 s", async () => {
    let up = false;
    const t = await rig({
      connect: async () => {
        if (!up) throw new TypeError("internal failure");
        return { isConnected: true, server: SERVER };
      },
    });
    await t.run();
    expect(t.fetched).toHaveLength(1);
    expect(outage(t)).toHaveLength(1);
    expect(outage(t)[0]).toContain("internal failure");
    up = true;
    t.clock.now += 60_000;
    await t.run();
    expect(t.requests()).toHaveLength(1);
    expect(t.fetched).toHaveLength(1);
  });

  it("a request call that resolves nothing falls back instead of throwing", async () => {
    const t = await rig({ onCall: () => undefined });
    expect(JSON.parse((await t.run()).result ?? "null")).toEqual(NOUL_ANSWER);
    expect(t.fetched).toHaveLength(1);
    expect(outage(t)[0]).toContain("not usable");
  });

  it("a connect that never answers is given up after 3 s", async () => {
    const t = await rig({ connect: NEVER });
    const pending = t.run();
    for (let i = 0; i < 100 && !t.timers.some((x) => x.ms === 3000); i++) await new Promise((r) => setImmediate(r));
    t.fire(3000);
    expect(JSON.parse((await pending).result ?? "null")).toEqual(NOUL_ANSWER);
    expect(t.fetched).toHaveLength(1);
  });

  it("a call abandoned while the connect is pending is answered at once and sends nothing", async () => {
    const t = await rig({ connect: NEVER });
    const ac = new AbortController();
    const pending = t.run("noul", {}, ac.signal);
    for (let i = 0; i < 100 && !t.timers.some((x) => x.ms === 3000); i++) await new Promise((r) => setImmediate(r));
    ac.abort();
    expect(await pending).toEqual({ deny: "noul: the call was abandoned" });
    t.fire(3000);
    await new Promise((r) => setImmediate(r));
    expect(t.fetched).toHaveLength(0);
  });

  for (const [name, hang] of [["store read", "store"], ["tool registration", "register"]] as const) {
    it(`a call abandoned while the ${name} is pending is answered before its timer and sends nothing`, async () => {
      // the store case needs the registration to finish, or the call is abandoned before it reaches the store
      let reached = false;
      const t = await rig({ register: async () => ({}), [hang]: () => (reached = true, NEVER()) });
      const ac = new AbortController();
      const pending = t.run("noul", {}, ac.signal);
      for (let i = 0; i < 100 && !reached; i++) await new Promise((r) => setImmediate(r));
      expect(reached).toBe(true);
      ac.abort();
      expect(await pending).toEqual({ deny: "noul: the call was abandoned" });
      expect(t.fetched).toHaveLength(0);
      expect(t.requests()).toHaveLength(0);
    });
  }

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

  it.each(["config", "request"])("a synchronous throw of the %s call falls back, marks the link down and logs once", async (tool) => {
    const boom = (): never => {
      throw new Error("server process exited");
    };
    const t = await rig(tool === "config" ? { onConfig: boom } : { onCall: boom });
    expect(JSON.parse((await t.run()).result ?? "null")).toEqual(NOUL_ANSWER);
    expect(t.fetched).toHaveLength(1);
    expect(outage(t)).toHaveLength(1);
    expect(outage(t)[0]).toContain("server process exited");
  });

  it("a result that is neither an outcome nor an error text falls back, an error text is the answer", async () => {
    const garbage = await rig({ onCall: () => ({ isError: false, content: [{ type: "text", text: "hello" }] }) });
    expect(JSON.parse((await garbage.run()).result ?? "null")).toEqual(NOUL_ANSWER);
    expect(garbage.fetched).toHaveLength(1);
    const odd = await rig({ onCall: () => ({ isError: false, content: [null, 3, { type: "text" }] as never }) });
    expect(JSON.parse((await odd.run()).result ?? "null")).toEqual(NOUL_ANSWER);
    expect(odd.fetched).toHaveLength(1);
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

  it("a call abandoned while the fallback reads the time left sends nothing", async () => {
    const t = await rig({ noMcp: true });
    const ac = new AbortController();
    const clock = (t.$ as { clock: { now: () => Promise<number> } }).clock;
    const real = clock.now;
    let reads = 0;
    clock.now = async () => (++reads === 4 && ac.abort(), real());
    expect(await t.run("noul", {}, ac.signal)).toEqual({ deny: "noul: the call was abandoned" });
    expect(t.fetched).toHaveLength(0);
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

describe("the configuration of the server", () => {
  it("is sent before the first request, once, and not again while it stays the same", async () => {
    const t = await rig({ env: { TYPESAFE_API_KEY: "k", JEV_URL: "https://jev.example/v1/systemone", TYPESAFE_DEFAULT_MODEL: " m " } });
    await t.run();
    await t.run();
    expect(t.configs().map((c) => c.args)).toEqual([{ key: "k", jevUrl: "https://jev.example/v1/systemone", model: "m", gen: 1 }]);
    expect(t.mcpCalls.map((c) => c.tool)).toEqual(["config", "request", "request"]);
  });
  it("is sent again when a value changed", async () => {
    const t = await rig();
    await t.run();
    t.env["TYPESAFE_API_KEY"] = "k2";
    await t.run();
    expect(t.configs().map((c) => c.args)).toEqual([{ key: "k", gen: 1 }, { key: "k2", gen: 2 }]);
  });
  it("is sent again after a failed request, read fresh, before the next one", async () => {
    let n = 0;
    const t = await rig({ onCall: () => (++n === 1 ? outcome({ kind: "http", status: 503 }) : okOutcome) });
    await t.run();
    expect(t.configs()).toHaveLength(1);
    await t.run();
    expect(t.configs()).toHaveLength(2);
    await t.run();
    expect(t.configs()).toHaveLength(2);
    expect(t.mcpCalls.map((c) => c.tool)).toEqual(["config", "request", "config", "request", "request"]);
  });
  it("is not resent after an abandoned request", async () => {
    let first = true;
    const t = await rig({ onCall: () => (first ? ((first = false), NEVER()) : okOutcome) });
    const ac = new AbortController();
    const p = t.run("noul", {}, ac.signal);
    await t.until("request", 1);
    ac.abort();
    await p;
    await t.run();
    expect(t.configs()).toHaveLength(1);
  });
  it("is sent again, and the request once more, when the server says it has none (a restarted server)", async () => {
    let n = 0;
    const t = await rig({ onCall: () => (++n === 1 ? outcome({ kind: "error", code: "unconfigured", message: "the server has no configuration yet" }) : okOutcome) });
    expect(JSON.parse((await t.run()).result ?? "null")).toEqual(NOUL_ANSWER);
    expect(t.mcpCalls.map((c) => c.tool)).toEqual(["config", "request", "config", "request"]);
    expect(t.fetched).toHaveLength(0);
  });
  it("a server that refuses or never answers its configuration is an outage: the fetch path answers", async () => {
    const refused = await rig({ onConfig: () => ({ isError: true, content: [{ type: "text", text: "config: nope" }] }) });
    expect(JSON.parse((await refused.run()).result ?? "null")).toEqual(NOUL_ANSWER);
    expect(refused.fetched).toHaveLength(1);
    expect(outage(refused)[0]).toContain("refused its configuration");
    const silent = await rig({ onConfig: NEVER });
    const p = silent.run();
    await silent.until("config", 1);
    silent.fire(3000);
    expect(JSON.parse((await p).result ?? "null")).toEqual(NOUL_ANSWER);
    expect(silent.fetched).toHaveLength(1);
  });
  it("session.start sends it ahead of the first request, only with System One access", async () => {
    const t = await rig();
    await t.hooks.get("session.start")?.(t.$, { cwd: "/p" }, async () => ({}));
    expect(t.configs().map((c) => c.args)).toEqual([{ key: "k", gen: 1 }]);
    await t.run();
    expect(t.configs()).toHaveLength(1);
    const none = await rig({ env: {} });
    await none.hooks.get("session.start")?.(none.$, { cwd: "/p" }, async () => ({}));
    expect(none.mcpCalls).toHaveLength(0);
  });
});

describe("Haiku takes over after an HTTP error status", () => {
  const HAIKU_OK = { isAnswered: true, text: JSON.stringify({ answers: { answer: { type: "noul", noul: 0.7 } } }), usage: {} };
  for (const status of [400, 404, 429, 500, 503]) {
    it(`HTTP ${status}: Haiku answers with the timeout less the time the request used`, async () => {
      const t = await rig({
        complete: () => HAIKU_OK,
        onCall: (c) => {
          if (c.tool === "request") t.clock.now += 4000; // the request used 4 s
          return outcome({ kind: "http", status, reason: "boom" });
        },
      });
      const r = await t.run("noul", { timeout: 20 });
      expect(JSON.parse(r.result ?? "null")).toMatchObject({ type: "noul" });
      expect(t.completed).toHaveLength(1);
      expect(t.completed[0]?.["timeoutMs"]).toBe(16_000);
    });
  }
  it("the same through the fetch path", async () => {
    const t = await rig({ noMcp: true, complete: () => HAIKU_OK });
    t.$.http.fetch = () => {
      t.clock.now += 2500;
      return Promise.resolve({ status: 502, ok: false, headers: {}, text: "{}" });
    };
    expect(JSON.parse((await t.run("noul", { timeout: 10 })).result ?? "null")).toMatchObject({ type: "noul" });
    expect(t.completed[0]?.["timeoutMs"]).toBe(7500);
  });
  it("a request that used the whole timeout leaves no time: the HTTP error is the answer and Haiku is not asked", async () => {
    const t = await rig({
      onCall: (c) => {
        if (c.tool === "request") t.clock.now += 5000;
        return outcome({ kind: "http", status: 500, reason: "boom" });
      },
    });
    expect((await t.run("noul", { timeout: 5 })).deny).toBe("noul: HTTP 500: boom; no time left for the Haiku fallback");
    expect(t.completed).toHaveLength(0);
  });
  it("overflow haiku after the 400 refusal gets the time left, and none left is the refusal", async () => {
    for (const [used, expected] of [[3500, 500], [4000, undefined]] as const) {
      const t = await rig({
        complete: () => HAIKU_OK,
        onCall: (c) => {
          if (c.tool === "request") t.clock.now += used;
          return outcome({ kind: "http", status: 400, reason: "too big", refusal: { tokens: 40025, nctx: 32768 } });
        },
      });
      const r = await t.run("noul", { timeout: 4, overflow: "haiku" });
      expect(t.completed[0]?.["timeoutMs"]).toBe(expected);
      if (expected === undefined) expect(r.deny).toMatch(/state too large/);
    }
  });
  it("overflow truncate after the 400 refusal sends the cut with the time left, and none left is the refusal", async () => {
    for (const [used, expected] of [[3500, 500], [4000, undefined]] as const) {
      const t = await rig({
        onCall: (c) => {
          if (c.tool === "request") t.clock.now += used;
          return outcome({ kind: "http", status: 400, reason: "too big", refusal: { tokens: 40025, nctx: 32768 } });
        },
      });
      const r = await t.run("noul", { timeout: 4, overflow: "truncate", state: "a".repeat(9000) });
      const timeouts = t.requests().map((c) => c.args["timeoutMs"]);
      expect(timeouts).toEqual(expected === undefined ? [4000] : [4000, expected]);
      expect(r.deny).toMatch(/state too large/);
      // sized to the 500 ms left (the 1000-token floor), not to the 4 s the call started with
      if (expected !== undefined) expect(String(t.requests()[1].args["state"]).length).toBeLessThan(400); // the 4 s budget would keep about 900
    }
  });
  it("when Haiku fails too, the error carries both reasons", async () => {
    const t = await rig({ complete: () => ({ isAnswered: false, reason: "overloaded" }), onCall: () => outcome({ kind: "http", status: 500, reason: "boom" }) });
    const r = await t.hooks.get("tool.call")?.(t.$, { tool: TOOL("noul"), ...BASE }, Object.assign(async () => ({}), { signal: new AbortController().signal }));
    expect(r).toEqual({ deny: "noul: HTTP 500: boom; fallback: overloaded" });
  });
  it("no other failure goes to Haiku: a timeout, a network error and an invalid endpoint stay errors", async () => {
    for (const o of [{ kind: "error", code: "network", message: "fetch failed (ECONNREFUSED)" }, { kind: "error", code: "timeout", message: "timeout after 20000ms" }, { kind: "error", code: "config", message: "JEV_URL must be an http(s) URL" }]) {
      const t = await rig({ complete: () => HAIKU_OK, onCall: () => outcome(o) });
      expect((await t.run()).deny).toBe(`noul: ${o["message"]}`);
      expect(t.completed).toHaveLength(0);
    }
  });
  it("an abandoned call is not handed to Haiku", async () => {
    const ac = new AbortController();
    const t = await rig({ complete: () => HAIKU_OK, onCall: () => outcome({ kind: "http", status: 500 }) });
    const real = t.$.clock.now;
    // the abort comes after the HTTP outcome is back: the first clock read then is takeOver's own
    (t.$.clock as { now: () => Promise<number> }).now = () => (t.requests().length > 0 && ac.abort(), real());
    expect((await t.run("noul", {}, ac.signal)).deny).toBe("noul: the call was abandoned");
    expect(t.completed).toHaveLength(0);
  });
  it("a call abandoned after a context refusal, while the time left is read, is not handed to Haiku", async () => {
    const ac = new AbortController();
    const t = await rig({ complete: () => HAIKU_OK, onCall: () => outcome({ kind: "http", status: 400, refusal: { tokens: 40000, nctx: 32768 } }) });
    const real = t.$.clock.now;
    (t.$.clock as { now: () => Promise<number> }).now = () => (t.requests().length > 0 && ac.abort(), real());
    expect((await t.run("noul", { overflow: "haiku" }, ac.signal)).deny).toBe("noul: the call was abandoned");
    expect(t.completed).toHaveLength(0);
  });
  it("a context refusal still follows the overflow mode, not Haiku", async () => {
    const refusal = outcome({ kind: "http", status: 400, refusal: { tokens: 40000, nctx: 32768 } });
    const t = await rig({ complete: () => HAIKU_OK, onCall: () => refusal });
    expect((await t.run("noul", { overflow: "error" })).deny).toMatch(/^noul: state too large/);
    expect(t.completed).toHaveLength(0);
  });
});

describe("concurrent calls with different env", () => {
  it("each request is served with the config of its own call, whatever order the config answers come in", async () => {
    for (const order of [[0, 1], [1, 0]]) {
      let held: { key: unknown; gen: unknown } | undefined; // the server's one global config, replaced by every config call
      const served: [unknown, unknown][] = [];
      const release: (() => void)[] = [];
      const t = await rig({
        onConfig: (c) => new Promise((resolve) => release.push(() => ((held = { key: c.args["key"], gen: c.args["gen"] }), resolve(outcome({ configured: true }))))),
        onCall: (c) => {
          if (held === undefined || c.args["configGen"] !== held.gen) return outcome({ kind: "error", code: "unconfigured", message: "x" });
          served.push([c.args["state"], held.key]);
          return okOutcome;
        },
      });
      t.env["TYPESAFE_API_KEY"] = "kA";
      const a = t.run("noul", { state: "A" });
      await t.until("config", 1);
      t.env["TYPESAFE_API_KEY"] = "kB";
      const b = t.run("noul", { state: "B" });
      await t.until("config", 2);
      for (const i of order) release[i]();
      // a refused request makes its call send its config again
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setImmediate(r));
        release.splice(0).forEach((f) => f());
      }
      await Promise.all([a, b]);
      for (const [state, key] of served) expect(key).toBe(state === "A" ? "kA" : "kB");
      expect(served).toHaveLength(2);
    }
  });
});

describe("concurrent calls with the same env", () => {
  it("share one config call, so no request is refused for another call's generation", async () => {
    let held: unknown;
    const t = await rig({
      onConfig: (c) => ((held = c.args["gen"]), outcome({ configured: true })),
      onCall: (c) => (c.args["configGen"] === held ? okOutcome : outcome({ kind: "error", code: "unconfigured", message: "x" })),
    });
    const rs = await Promise.all([t.run(), t.run(), t.run()]);
    expect(rs.every((r) => r.deny === undefined)).toBe(true);
    expect(t.requests()).toHaveLength(3);
  });
});

describe("concurrent calls after a server restart", () => {
  it("a config another call already sent again serves this call's retry, so neither retried request is refused", async () => {
    let held: unknown;
    let hold = false;
    const answers: (() => void)[] = [];
    const t = await rig({
      onConfig: (c) => ((held = c.args["gen"]), outcome({ configured: true })),
      onCall: (c) => {
        const r = c.args["configGen"] === held ? okOutcome : outcome({ kind: "error", code: "unconfigured", message: "x" });
        return hold ? new Promise((resolve) => answers.push(() => resolve(r))) : r;
      },
    });
    expect((await t.run()).deny).toBeUndefined();
    held = undefined; // the server restarted
    hold = true;
    // the clock stops once the second config was sent, between a retry's config and its request
    let open: () => void = () => {};
    const gate = new Promise<void>((r) => (open = r));
    const now = t.$.clock.now;
    t.$.clock.now = async () => (t.configs().length >= 2 ? (await gate, now()) : now());
    const tick = async () => {
      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    };
    const a = t.run();
    const b = t.run();
    await t.until("request", 3);
    hold = false;
    answers[0](); // A: unconfigured, sends the config again and waits at the clock
    await t.until("config", 2);
    await tick();
    answers[1](); // B: unconfigured, while A's request is not sent yet
    await tick();
    open();
    const rs = await Promise.all([a, b]);
    expect(rs.map((r) => r.deny)).toEqual([undefined, undefined]);
    expect(t.configs()).toHaveLength(2);
  });
});

describe("sendOutcome doc", () => {
  it("does not claim the server reads its own environment (it is given the env)", () => {
    const src = readFileSync(new URL("../src/hooks/transport.mts", import.meta.url), "utf8");
    expect(src).not.toMatch(/server reads its own environment/);
  });
});
