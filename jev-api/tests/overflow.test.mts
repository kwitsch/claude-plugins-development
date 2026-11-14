// Kit tests for F21 of jev-api: the oversized-state handling (preflight bounds, the 400 oracle, the overflow modes, the
// learned characters per token), run against the built plugin/hooks/register.mjs.
import { createKit } from "claude-engine-vitest";
import type { On } from "claude-engine-vitest";
import { expect } from "vitest";

const { test, mock } = createKit({ module: new URL("../plugin/hooks/register.mjs", import.meta.url), plugin: "jev-api" });

type Reply = { value: { status: number; ok: boolean; headers: Record<string, string>; text: string } } | { deny: string };
type Fetched = { url: string; body: { model: string; state: string; questions: Record<string, Record<string, unknown>> } };
type Runner = Parameters<Parameters<typeof test>[2]>[0];
type Result = { result?: string; deny?: string };

const TOOL = (type: string) => `mcp__jev-api__${type}`;
const JEV = { JEV_URL: "https://jev.example/v1/systemone", TYPESAFE_API_KEY: "sk-test-key-123456" };

const httpReply = (status: number, text: string): Reply => ({ value: { status, ok: status < 300, headers: {}, text } });

/** A System One answer for one noul question; `tokens` is the usage the server reports. */
const okReply = (tokens?: number): Reply => httpReply(200, JSON.stringify({ model: "d1-3b", answers: { answer: { type: "noul", noul: 0.9 } }, usage: tokens === undefined ? {} : { input_tokens: tokens, output_tokens: 0 } }));

/** The server's rejection of a prompt over its context window, as measured live on 2026-11-14. */
const tooBig = (tokens: number, nctx = 32768): Reply => httpReply(400, JSON.stringify({ error: { code: 400, message: `request (${tokens} tokens) exceeds the available context size (${nctx} tokens), try increasing it`, type: "exceed_context_size_error", n_prompt_tokens: tokens, n_ctx: nctx } }));

/** The `$.store` of a test: records every set and can be primed or made to fail. */
type Store = { data: Map<string, unknown>; sets: [string, unknown][]; gets: string[]; failGet: boolean; failSet: boolean };

/**
 * Stubs every `$` op the module uses: env (explicit), the clock, tool registration, `http.fetch` (answers come from
 * `replies`, in order, the last one repeating), `store.*` and `session.start`.
 */
function setup(on: On, opts: { env?: Record<string, string>; replies?: Reply[]; store?: Record<string, unknown> } = {}) {
  const fetched: Fetched[] = [];
  const specs: Record<string, unknown>[] = [];
  const store: Store = { data: new Map(Object.entries(opts.store ?? {})), sets: [], gets: [], failGet: false, failSet: false };
  mock.env(on, opts.env ?? JEV);
  mock.clock(on);
  on("tool.register", async (_$, e) => {
    specs.push(e);
    return { value: { tool: TOOL(String(e.name)) } };
  });
  const replies = opts.replies ?? [okReply()];
  on("http.fetch", (_$, e) => {
    const init = e.init as { body: string };
    fetched.push({ url: String(e.url), body: JSON.parse(init.body) as Fetched["body"] });
    return replies[Math.min(fetched.length - 1, replies.length - 1)];
  });
  on("store.get", (_$, e) => {
    store.gets.push(String(e.key));
    if (store.failGet) return { deny: "store unavailable" };
    return { value: store.data.get(String(e.key)) };
  });
  on("store.set", (_$, e) => {
    if (store.failSet) return { deny: "store full" };
    store.sets.push([String(e.key), e.value]);
    store.data.set(String(e.key), e.value);
    return { value: undefined };
  });
  on("session.start", async (_$, e) => ({ cwd: e.cwd }));
  return { fetched, specs, store };
}

const BASE: Record<string, Record<string, unknown>> = {
  noul: { instructions: "Is this text about animals?", state: "Hello there!" },
  choice: { instructions: "What is this text?", state: "Hello there!", criteria: { greeting: "says hello", question: "asks something" } },
  score: { instructions: "Rate the sentiment", state: "Hello there!", criteria: ["negative", "neutral", "positive"] },
  batch: { state: "Hello there!", questions: [{ type: "noul", instructions: "Is this text about animals?" }] },
};

const call = ($: Runner, type: string, input: Record<string, unknown> = {}) => $.tool.call({ tool: TOOL(type), ...BASE[type], ...input }) as Promise<Result>;

// --- Phase 2: the overflow input and option -------------------------------------------------------------------------

test("every tool's input schema offers the overflow modes, and none requires them", async ($, on) => {
  const { specs } = setup(on);
  await $.session.start({ cwd: "/proj", surface: "terminal", isInteractive: true });
  expect(specs).toHaveLength(4);
  for (const spec of specs) {
    const schema = spec["inputSchema"] as { properties: Record<string, { enum?: string[] }>; required: string[] };
    expect(schema.properties["overflow"]?.enum).toEqual(["error", "truncate", "haiku"]);
    expect(schema.required).not.toContain("overflow");
  }
});

for (const type of ["noul", "choice", "score", "batch"]) {
  for (const bad of ["fail", "", 1, null, ["error"]]) {
    test(`${type} with overflow ${JSON.stringify(bad)} is refused before any request`, async ($, on) => {
      const { fetched } = setup(on);
      const r = await call($, type, { overflow: bad });
      expect(r.deny).toBe(`${type}: overflow must be one of error, truncate, haiku`);
      expect(fetched).toHaveLength(0);
    });
  }
  test(`${type} accepts each valid overflow value and answers normally for a small state`, async ($, on) => {
    const { fetched } = setup(on, { replies: [httpReply(200, JSON.stringify({ answers: { answer: { type: "noul", noul: 0.5 }, q0: { type: "noul", noul: 0.5 }, ...(type === "choice" ? { answer: { type: "choice", choice: "greeting", confidence: 0.9, probabilities: { greeting: 0.9, question: 0.1 } } } : {}), ...(type === "score" ? { answer: { type: "score", score: 1, confidence: 0.5, legend: {}, probabilities: { 0: 0.2, 1: 0.6, 2: 0.2 } } } : {}) } }))] });
    for (const overflow of ["error", "truncate", "haiku"]) {
      const r = await call($, type, { overflow });
      expect(r.deny).toBeUndefined();
    }
    expect(fetched).toHaveLength(3);
  });
}

// --- Phase 3: what ask() learns and reports ----------------------------------------------------------------------------

/** The characters of the prompt the module counts: the state plus the questions JSON of the request body. */
const promptChars = (f: Fetched) => f.body.state.length + JSON.stringify(f.body.questions).length;

/** The next learned density after one sample: 80 % old, 20 % new, the sample clamped to 1..8. */
const smoothed = (old: number, sample: number) => 0.8 * old + 0.2 * Math.min(8, Math.max(1, sample));

const SMALL = { state: "a".repeat(20_000), timeout: 30 };

test("a successful answer teaches the density, and a large move is stored as { v, n }", async ($, on) => {
  const { fetched, store } = setup(on, { replies: [okReply(3000)] });
  expect((await call($, "noul", SMALL)).deny).toBeUndefined();
  expect(store.sets).toHaveLength(1);
  const [key, value] = store.sets[0] as [string, { v: number; n: number }];
  expect(key).toBe("density");
  expect(value.v).toBeCloseTo(smoothed(3, promptChars(fetched[0]) / (3000 - 26)), 6);
  expect(value.n).toBe(1);
});

test("a move of 10 % or less is not stored", async ($, on) => {
  // 20070 chars / 4974 tokens = 4.03: 3.0 -> 3.21 (+6.9 %): stays in memory only.
  const { store } = setup(on, { replies: [okReply(5000)] });
  await call($, "noul", SMALL);
  expect(store.sets).toHaveLength(0);
});

test("a move just over 10 % is stored", async ($, on) => {
  // Sample 4.7 moves 3.0 to 3.34 (+11.3 %).
  const { store, fetched } = setup(on, { replies: [okReply(4300)] });
  await call($, "noul", SMALL);
  expect(promptChars(fetched[0]) / (4300 - 26)).toBeGreaterThan(4.6);
  expect(store.sets).toHaveLength(1);
});

test("an answer reporting 399 prompt tokens teaches nothing", async ($, on) => {
  const { store } = setup(on, { replies: [okReply(399)] });
  await call($, "noul", { state: "a".repeat(3000) });
  expect(store.sets).toHaveLength(0);
});

test("an answer reporting 400 prompt tokens teaches (sample clamped to 8: 3.0 -> 4.0)", async ($, on) => {
  const { store } = setup(on, { replies: [okReply(400)] });
  await call($, "noul", { state: "a".repeat(3000) });
  expect(store.sets).toHaveLength(1);
  expect((store.sets[0][1] as { v: number }).v).toBeCloseTo(4, 6);
});

test("a tiny sample counts as 1 character per token (3.0 -> 2.6)", async ($, on) => {
  const { store } = setup(on, { replies: [okReply(3026)] });
  await call($, "noul", { state: "a".repeat(600) });
  expect((store.sets[0][1] as { v: number }).v).toBeCloseTo(2.6, 6);
});

for (const [name, usage] of [["no usage", undefined], ["a text token count", "5000"], ["a negative token count", -5000], ["a zero token count", 0], ["a null token count", null]] as const) {
  test(`${name} in the answer teaches nothing and does not fail the call`, async ($, on) => {
    const reply = httpReply(200, JSON.stringify({ answers: { answer: { type: "noul", noul: 0.9 } }, usage: usage === undefined ? undefined : { input_tokens: usage } }));
    const { store } = setup(on, { replies: [reply] });
    expect((await call($, "noul", SMALL)).deny).toBeUndefined();
    expect(store.sets).toHaveLength(0);
  });
}

test("the stored density is the starting point of a new module instance", async ($, on) => {
  const { store, fetched } = setup(on, { replies: [okReply(3000)], store: { density: { v: 1.5, n: 3 } } });
  await call($, "noul", SMALL);
  const stored = store.sets[0][1] as { v: number; n: number };
  expect(stored.v).toBeCloseTo(smoothed(1.5, promptChars(fetched[0]) / (3000 - 26)), 6);
  expect(stored.n).toBe(4);
});

for (const [name, bad] of [["out of range", { v: 99, n: 1 }], ["below 1", { v: 0.5, n: 1 }], ["not a number", { v: "x", n: 1 }], ["not finite", { v: null, n: 1 }], ["no object", 3], ["null", null]] as const) {
  test(`a stored density that is ${name} is ignored`, async ($, on) => {
    const { store, fetched } = setup(on, { replies: [okReply(3000)], store: { density: bad } });
    await call($, "noul", SMALL);
    expect((store.sets[0][1] as { v: number }).v).toBeCloseTo(smoothed(3, promptChars(fetched[0]) / (3000 - 26)), 6);
  });
}

test("the store is read once per module instance, not on every call", async ($, on) => {
  const { store } = setup(on, { replies: [okReply(5000)] });
  await call($, "noul", SMALL);
  await call($, "noul", SMALL);
  expect(store.gets).toEqual(["density"]);
});

test("a failing store read or write never fails the call", async ($, on) => {
  const { store } = setup(on, { replies: [okReply(3000)] });
  store.failGet = true;
  store.failSet = true;
  const r = await call($, "noul", SMALL);
  expect(r.deny).toBeUndefined();
  expect(JSON.parse(r.result ?? "null")).toMatchObject({ type: "noul" });
});

test("a call with no System One access (Haiku) never touches the store", async ($, on) => {
  const { store } = setup(on, { env: {} });
  on("model.complete", () => ({ value: { isAnswered: true, text: JSON.stringify({ answers: { answer: { type: "noul", noul: 0.5 } } }), usage: {} } }));
  await call($, "noul", SMALL);
  expect(store.gets).toHaveLength(0);
  expect(store.sets).toHaveLength(0);
});

/** The state characters the translated error allows: the limit minus overhead and margin, scaled, minus the questions, in hundreds. */
const allowedState = (f: Fetched, tokens: number, limit: number) => {
  const prompt = Math.floor((promptChars(f) * (limit - 26 - 64)) / (tokens - 26));
  return Math.max(0, Math.floor((prompt - JSON.stringify(f.body.questions).length) / 100)) * 100;
};

const BIG = { state: "a".repeat(100_000), timeout: 30, overflow: "error" };

test("the server's context rejection becomes a clear refusal with the numbers and a size to aim for", async ($, on) => {
  const { fetched } = setup(on, { replies: [tooBig(40025)] });
  const r = await call($, "noul", BIG);
  const aim = allowedState(fetched[0], 40025, 32767);
  expect(r.deny).toBe(`noul: state too large for System One: the request has 40025 tokens, the limit is 32767; shorten the state to about ${aim} characters`);
  expect(fetched).toHaveLength(1);
});

test("the limit is the server's n_ctx minus one", async ($, on) => {
  const { fetched } = setup(on, { replies: [tooBig(20000, 16384)] });
  const r = await call($, "noul", BIG);
  expect(r.deny).toContain("the limit is 16383;");
  expect(r.deny).toContain(`about ${allowedState(fetched[0], 20000, 16383)} characters`);
});

test("a rejection teaches the density from its exact token count", async ($, on) => {
  const { store, fetched } = setup(on, { replies: [tooBig(20000, 16384)] });
  await call($, "noul", BIG);
  expect((store.sets[0][1] as { v: number }).v).toBeCloseTo(smoothed(3, promptChars(fetched[0]) / (20000 - 26)), 6);
});

for (const [name, text] of [["another error type", JSON.stringify({ error: { code: 400, type: "invalid_request_error", message: "bad request", n_prompt_tokens: 40025, n_ctx: 32768 } })], ["no token counts", JSON.stringify({ error: { code: 400, type: "exceed_context_size_error", message: "too big" } })], ["a non-numeric token count", JSON.stringify({ error: { code: 400, type: "exceed_context_size_error", message: "too big", n_prompt_tokens: "40025", n_ctx: 32768 } })], ["not JSON", "<html>400</html>"]] as const) {
  test(`a 400 with ${name} keeps the generic HTTP error text`, async ($, on) => {
    setup(on, { replies: [httpReply(400, text)] });
    const r = await call($, "noul", BIG);
    expect(r.deny).toMatch(/^noul: HTTP 400/);
  });
}
