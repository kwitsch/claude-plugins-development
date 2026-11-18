// Tests of the MCP transport of the jev-api mod: the hooks driven directly with a hand-made `$` (the kit cannot abandon a dispatch).
import { describe, expect, it } from "vitest";

const TOOL = (type: string) => `mcp__jev-api__${type}`;
const SERVER = "plugin:jev-api:http";
const NOUL_ANSWER = { type: "noul", noul: 0.9 };
const OK_TEXT = JSON.stringify({ answers: { q0: NOUL_ANSWER }, usage: {} });
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
async function rig(opts: { connect?: () => Promise<unknown>; onCall?: (c: Call) => unknown; noMcp?: boolean; complete?: (r: Args) => unknown; store?: () => Promise<unknown>; register?: () => Promise<unknown>; options?: Record<string, unknown>; env?: Record<string, string> } = {}) {
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
          if (opts.onCall) return Promise.resolve(opts.onCall(c));
          return Promise.resolve(tool === "cancel" ? { isError: false, content: [{ type: "text", text: "{\"cancelled\":true}" }], structuredContent: { cancelled: true } } : okOutcome);
        },
      },
    }),
  };
  // an HTTP error is taken over by Haiku: the stub has none by default, its failure text is cut off
  const run = async (type = "noul", input: Args = {}, signal: AbortSignal = new AbortController().signal) => {
    const r = (await hooks.get("tool.call")?.($, { tool: TOOL("request"), state: BASE.state, questions: [{ type, instructions: BASE.instructions }], ...input }, Object.assign(async () => ({}), { signal }))) as { result?: string; deny?: string };
    return r.deny === undefined ? r : { ...r, deny: r.deny.replace("; fallback: unavailable", "") };
  };
  /** Runs every live timer of this length. */
  const fire = (ms: number) => timers.filter((t) => t.ms === ms && !t.cancelled).forEach((t) => t.fn());
  const requests = () => mcpCalls.filter((c) => c.tool === "request");
  const cancels = () => mcpCalls.filter((c) => c.tool === "cancel");
  /** Waits until n calls of a tool were made. */
  const until = async (tool: string, n: number) => {
    for (let i = 0; i < 200 && mcpCalls.filter((c) => c.tool === tool).length < n; i++) await new Promise((r) => setImmediate(r));
  };
  return { hooks, $, run, mcpCalls, fetched, logs, timers, clock, connects, fire, requests, cancels, completed, env, until };
}

const NEVER = () => new Promise<never>(() => {});

/** The log lines about the transport server (the registration of the tools logs too in this world, where `$.tool` is missing). */
const outage = (t: Rig) => t.logs.filter((l) => l.startsWith("jev-api: HTTP server not available"));

describe("the request goes through the server", () => {
  it("sends one request call with callId, state, questions and timeoutMs, and no http.fetch", async () => {
    const t = await rig();
    const r = await t.run();
    expect(JSON.parse(r.result ?? "null")).toEqual([NOUL_ANSWER]);
    expect(t.fetched).toHaveLength(0);
    expect(t.connects.n).toBe(1);
    expect(t.requests()).toHaveLength(1);
    const call = t.requests()[0];
    expect(call.server).toBe(SERVER);
    expect(call.args).toMatchObject({ state: BASE.state, timeoutMs: 20000, questions: { q0: { type: "noul", instructions: BASE.instructions } } });
    expect(call.args["callId"]).toMatch(/^[a-z0-9]+-\d+$/);
    expect(Object.keys(call.args).sort((a, b) => a.localeCompare(b))).toEqual(["callId", "questions", "state", "timeoutMs"]);
    // the server reads its own environment: no config call precedes the request
    expect(t.mcpCalls.map((c) => c.tool)).toEqual(["request"]);
  });

  it("the request gets only the time the connect left, and none left is a timeout", async () => {
    for (const [used, expected] of [[2900, 1100], [4000, undefined]] as [number, number | undefined][]) {
      const t = await rig({ connect: async () => (t.clock.now += used, { isConnected: true, server: SERVER }) });
      const r = await t.run("noul", { timeout: 4 });
      if (expected === undefined) {
        expect(t.requests()).toHaveLength(0);
        expect(r.deny).toContain("timeout after 4000ms");
      } else expect(t.requests()[0].args["timeoutMs"]).toBe(expected);
    }
  });

  it("a hung connect does not hold the call past a shorter timeout", async () => {
    const t = await rig({ connect: NEVER });
    const pending = t.run("noul", { timeout: 1 });
    for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
    t.clock.now += 1000;
    t.fire(1000);
    expect((await pending).deny).toContain("timeout after 1000ms");
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

  it("answers several questions from the same transport", async () => {
    const t = await rig({ onCall: () => outcome({ kind: "ok", status: 200, text: JSON.stringify({ answers: { q0: NOUL_ANSWER, q1: NOUL_ANSWER } }) }) });
    const r = await t.run("noul", { state: "s", questions: [{ type: "noul", instructions: "a?" }, { type: "noul", instructions: "b?" }] });
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
    expect(await t.run()).toEqual({ deny: "request: HTTP 500: boom" });
  });
  it("an http outcome without a reason", async () => {
    const t = await rig({ onCall: () => outcome({ kind: "http", status: 502 }) });
    expect(await t.run()).toEqual({ deny: "request: HTTP 502" });
  });
  it("error outcomes keep their text", async () => {
    for (const [code, message] of [["timeout", "timeout after 4000ms"], ["aborted", "the call was abandoned"], ["network", "fetch failed"], ["config", "no System One access configured: set TYPESAFE_API_KEY, TYPESAFE_BASE_URL or JEV_URL"]]) {
      const t = await rig({ onCall: () => outcome({ kind: "error", code, message }) });
      expect(await t.run()).toEqual({ deny: `request: ${message}` });
    }
  });
  it("an ok outcome with a wrong answer is the old response error", async () => {
    const t = await rig({ onCall: () => outcome({ kind: "ok", status: 200, text: "{\"answers\":{}}" }) });
    expect(await t.run()).toEqual({ deny: "request: response had no valid noul answer for questions[0]" });
  });
  it("a context refusal is the translated refusal in error mode", async () => {
    const t = await rig({ onCall: () => outcome({ kind: "http", status: 400, reason: "too big", refusal: { tokens: 40025, nctx: 32768 } }) });
    const r = await t.run("noul", { overflow: "error" });
    expect(r.deny).toMatch(/^request: state too large for System One: the request has 40025 tokens, the limit is 32767;/);
  });
  it("a context refusal in truncate mode sends one more, shorter request through the server", async () => {
    let n = 0;
    const t = await rig({ onCall: () => (n++ === 0 ? outcome({ kind: "http", status: 400, reason: "too big", refusal: { tokens: 40025, nctx: 32768 } }) : okOutcome) });
    const r = await t.run("noul", { overflow: "truncate", state: "x".repeat(2000) });
    expect(JSON.parse(r.result ?? "null")).toEqual([NOUL_ANSWER]);
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
    expect(await pending).toEqual({ deny: "request: timeout after 20000ms" });
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
    expect(await pending).toEqual({ deny: "request: the call was abandoned" });
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
    expect(await pending).toEqual({ deny: "request: the call was abandoned" });
    expect(t.requests()).toHaveLength(1);
    expect(t.cancels()).toHaveLength(0);
  });

  it("a dispatch abandoned while the time left is read sends no request", async () => {
    const t = await rig();
    await t.run(); // connects
    const ctl = new AbortController();
    let reads = 0; // 1 start time, 2 call id, 3 time left
    (t.$.clock as { now: () => Promise<number> }).now = async () => (++reads === 3 && ctl.abort(), 1_000_000);
    expect(await t.run("noul", {}, ctl.signal)).toEqual({ deny: "request: the call was abandoned" });
    expect(reads).toBeGreaterThanOrEqual(3);
    expect(t.requests()).toHaveLength(1);
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
    expect(await pending).toEqual({ deny: "request: timeout after 20000ms" });
  });
});

describe("fallback to $.http.fetch", () => {
  it("a server that is not connected is replaced by the fetch path, with one log line per outage", async () => {
    const t = await rig({ connect: async () => ({ isConnected: false, message: "spawn node ENOENT" }) });
    expect(JSON.parse((await t.run()).result ?? "null")).toEqual([NOUL_ANSWER]);
    expect(JSON.parse((await t.run()).result ?? "null")).toEqual([NOUL_ANSWER]);
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
        expect(r.deny).toBe("request: timeout after 4000ms");
      } else {
        expect(t.fetched).toHaveLength(1);
        expect(t.timers.filter((x) => x.ms === left)).toHaveLength(1);
        expect(t.timers.filter((x) => x.ms === 4000 && !x.cancelled)).toHaveLength(0);
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
    expect(JSON.parse((await t.run()).result ?? "null")).toEqual([NOUL_ANSWER]);
    expect(t.fetched).toHaveLength(1);
    expect(outage(t)[0]).toContain("not usable");
  });

  it("a connect that never answers is given up after 3 s", async () => {
    const t = await rig({ connect: NEVER });
    const pending = t.run();
    for (let i = 0; i < 100 && !t.timers.some((x) => x.ms === 3000); i++) await new Promise((r) => setImmediate(r));
    t.fire(3000);
    expect(JSON.parse((await pending).result ?? "null")).toEqual([NOUL_ANSWER]);
    expect(t.fetched).toHaveLength(1);
  });

  it("a call abandoned while the connect is pending is answered at once and sends nothing", async () => {
    const t = await rig({ connect: NEVER });
    const ac = new AbortController();
    const pending = t.run("noul", {}, ac.signal);
    for (let i = 0; i < 100 && !t.timers.some((x) => x.ms === 3000); i++) await new Promise((r) => setImmediate(r));
    ac.abort();
    expect(await pending).toEqual({ deny: "request: the call was abandoned" });
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
      expect(await pending).toEqual({ deny: "request: the call was abandoned" });
      expect(t.fetched).toHaveLength(0);
      expect(t.requests()).toHaveLength(0);
    });
  }

  it("a throwing request call falls back for that call, marks the link down and logs once", async () => {
    const t = await rig({ onCall: () => Promise.reject(new Error("transport closed")) });
    expect(JSON.parse((await t.run()).result ?? "null")).toEqual([NOUL_ANSWER]);
    expect(t.fetched).toHaveLength(1);
    await t.run();
    expect(t.fetched).toHaveLength(2);
    expect(t.requests()).toHaveLength(1);
    expect(t.connects.n).toBe(1);
    expect(outage(t)).toHaveLength(1);
    expect(outage(t)[0]).toContain("transport closed");
  });

  it("a synchronous throw of the request call falls back, marks the link down and logs once", async () => {
    const boom = (): never => {
      throw new Error("server process exited");
    };
    const t = await rig({ onCall: boom });
    expect(JSON.parse((await t.run()).result ?? "null")).toEqual([NOUL_ANSWER]);
    expect(t.fetched).toHaveLength(1);
    expect(outage(t)).toHaveLength(1);
    expect(outage(t)[0]).toContain("server process exited");
  });

  it("a result that is neither an outcome nor an error text falls back, an error text is the answer", async () => {
    const garbage = await rig({ onCall: () => ({ isError: false, content: [{ type: "text", text: "hello" }] }) });
    expect(JSON.parse((await garbage.run()).result ?? "null")).toEqual([NOUL_ANSWER]);
    expect(garbage.fetched).toHaveLength(1);
    const odd = await rig({ onCall: () => ({ isError: false, content: [null, 3, { type: "text" }] as never }) });
    expect(JSON.parse((await odd.run()).result ?? "null")).toEqual([NOUL_ANSWER]);
    expect(odd.fetched).toHaveLength(1);
    const text = await rig({ onCall: () => ({ isError: true, content: [{ type: "text", text: "request: state must be a non-empty string" }] }) });
    expect(await text.run()).toEqual({ deny: "request: request: state must be a non-empty string" });
    expect(text.fetched).toHaveLength(0);
  });

  it("without any mcp API (the older tests' world) the fetch path answers and nothing is logged about the server", async () => {
    const t = await rig({ noMcp: true });
    expect(JSON.parse((await t.run()).result ?? "null")).toEqual([NOUL_ANSWER]);
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
    expect(await t.run("noul", {}, ac.signal)).toEqual({ deny: "request: the call was abandoned" });
    expect(t.fetched).toHaveLength(0);
  });

  it("a call with no System One access (Haiku) never touches the server", async () => {
    const t = await rig({ env: {} });
    (t.$ as Record<string, unknown>)["model"] = { complete: async () => ({ isAnswered: true, text: JSON.stringify({ answers: { q0: NOUL_ANSWER } }), usage: {} }) };
    const r = await t.run();
    expect(JSON.parse(r.result ?? "null")).toMatchObject([{ type: "noul" }]);
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
      expect(String((r as { reason: string }).reason)).toContain("mcp__jev-api__request");
    }
  });
  it("leaves every other tool, also of a similar name, to the chain", async () => {
    const t = await rig();
    for (const tool of ["Bash", "mcp__jev-api__noul", "mcp__plugin_jev-api_http", "mcp__plugin_jev-api_httpx__request", "mcp__plugin_other_http__request"]) {
      expect(await check(t, tool, { plugin: "engine" })).toBe("passed");
    }
  });
});

describe("the server needs no configuration call", () => {
  it.each([
    ["http", { kind: "http", status: 503 }],
    ["error", { kind: "error", code: "network", message: "fetch failed" }],
  ])("a failed request (%s) causes no extra call: the next request goes out alone", async (_name, failed) => {
    let n = 0;
    const t = await rig({ onCall: () => (++n === 1 ? outcome(failed) : okOutcome) });
    await t.run();
    await t.run();
    expect(t.mcpCalls.map((c) => c.tool)).toEqual(["request", "request"]);
  });
  it("a changed env value sends nothing to the server", async () => {
    const t = await rig();
    await t.run();
    t.env["TYPESAFE_API_KEY"] = "k2";
    await t.run();
    expect(t.mcpCalls.map((c) => c.tool)).toEqual(["request", "request"]);
  });
  it("session.start sends nothing to the server", async () => {
    const t = await rig();
    await t.hooks.get("session.start")?.(t.$, { cwd: "/p" }, async () => ({}));
    expect(t.mcpCalls).toHaveLength(0);
  });
});

describe("Haiku takes over after an HTTP error status", () => {
  const HAIKU_OK = { isAnswered: true, text: JSON.stringify({ answers: { q0: { type: "noul", noul: 0.7 } } }), usage: {} };
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
      expect(JSON.parse(r.result ?? "null")).toMatchObject([{ type: "noul" }]);
      expect(t.completed).toHaveLength(1);
      expect(t.completed[0]?.["timeoutMs"]).toBe(16_000);
    });
  }
  it("a request with several questions: an HTTP 500 is taken over by Haiku, which answers every question", async () => {
    const t = await rig({
      complete: () => ({ isAnswered: true, text: JSON.stringify({ answers: { q0: { type: "noul", noul: 0.7 }, q1: { type: "noul", noul: 0.2 } } }), usage: {} }),
      onCall: () => outcome({ kind: "http", status: 500, reason: "boom" }),
    });
    const r = await t.run("noul", { state: "s", questions: [{ type: "noul", instructions: "a?" }, { type: "noul", instructions: "b?" }] });
    expect(JSON.parse(r.result ?? "null")).toHaveLength(2);
    expect(t.completed).toHaveLength(1);
  });
  it("the same through the fetch path", async () => {
    const t = await rig({ noMcp: true, complete: () => HAIKU_OK });
    t.$.http.fetch = () => {
      t.clock.now += 2500;
      return Promise.resolve({ status: 502, ok: false, headers: {}, text: "{}" });
    };
    expect(JSON.parse((await t.run("noul", { timeout: 10 })).result ?? "null")).toMatchObject([{ type: "noul" }]);
    expect(t.completed[0]?.["timeoutMs"]).toBe(7500);
  });
  it("a request that used the whole timeout leaves no time: the HTTP error is the answer and Haiku is not asked", async () => {
    const t = await rig({
      onCall: (c) => {
        if (c.tool === "request") t.clock.now += 5000;
        return outcome({ kind: "http", status: 500, reason: "boom" });
      },
    });
    expect((await t.run("noul", { timeout: 5 })).deny).toBe("request: HTTP 500: boom; no time left for the Haiku fallback");
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
    const r = await t.hooks.get("tool.call")?.(t.$, { tool: TOOL("request"), state: BASE.state, questions: [{ type: "noul", instructions: BASE.instructions }] }, Object.assign(async () => ({}), { signal: new AbortController().signal }));
    expect(r).toEqual({ deny: "request: HTTP 500: boom; fallback: overloaded" });
  });
  it("no other failure goes to Haiku: a timeout, a network error and an invalid endpoint stay errors", async () => {
    for (const o of [{ kind: "error", code: "network", message: "fetch failed (ECONNREFUSED)" }, { kind: "error", code: "timeout", message: "timeout after 20000ms" }, { kind: "error", code: "config", message: "JEV_URL must be an http(s) URL" }]) {
      const t = await rig({ complete: () => HAIKU_OK, onCall: () => outcome(o) });
      expect((await t.run()).deny).toBe(`request: ${o["message"]}`);
      expect(t.completed).toHaveLength(0);
    }
  });
  it("an abandoned call is not handed to Haiku", async () => {
    const ac = new AbortController();
    const t = await rig({ complete: () => HAIKU_OK, onCall: () => outcome({ kind: "http", status: 500 }) });
    const real = t.$.clock.now;
    // the abort comes after the HTTP outcome is back: the first clock read then is takeOver's own
    (t.$.clock as { now: () => Promise<number> }).now = () => (t.requests().length > 0 && ac.abort(), real());
    expect((await t.run("noul", {}, ac.signal)).deny).toBe("request: the call was abandoned");
    expect(t.completed).toHaveLength(0);
  });
  it("a call abandoned after a context refusal, while the time left is read, is not handed to Haiku", async () => {
    const ac = new AbortController();
    const t = await rig({ complete: () => HAIKU_OK, onCall: () => outcome({ kind: "http", status: 400, refusal: { tokens: 40000, nctx: 32768 } }) });
    const real = t.$.clock.now;
    (t.$.clock as { now: () => Promise<number> }).now = () => (t.requests().length > 0 && ac.abort(), real());
    expect((await t.run("noul", { overflow: "haiku" }, ac.signal)).deny).toBe("request: the call was abandoned");
    expect(t.completed).toHaveLength(0);
  });
  it("a context refusal still follows the overflow mode, not Haiku", async () => {
    const refusal = outcome({ kind: "http", status: 400, refusal: { tokens: 40000, nctx: 32768 } });
    const t = await rig({ complete: () => HAIKU_OK, onCall: () => refusal });
    expect((await t.run("noul", { overflow: "error" })).deny).toMatch(/^request: state too large/);
    expect(t.completed).toHaveLength(0);
  });
});
