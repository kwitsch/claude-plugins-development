// Kit tests for the built plugin/hooks/register.mjs of jev-api: the three System One tools noul, choice, score.
import { createKit } from "claude-engine-vitest";
import type { On } from "claude-engine-vitest";
import { describe, expect, it } from "vitest";

const { test, mock } = createKit({ module: new URL("../plugin/hooks/register.mjs", import.meta.url), plugin: "jev-api" });

type Reply = { value: { status: number; ok: boolean; headers: Record<string, string>; text: string } } | { deny: string } | Promise<never>;
type Fetched = { url: string; method: string; headers: Record<string, string>; body: { model: string; state: string; questions: { answer: Record<string, unknown> } } };

const TOOL = (type: string) => `mcp__jev-api__${type}`;

// The API's answer object per type (shapes as the live server answers: score is the expected level, legend and probabilities are keyed by level index).
const ANSWERS: Record<string, unknown> = {
  noul: { type: "noul", noul: 0.9 },
  choice: { type: "choice", choice: "greeting", confidence: 0.8, probabilities: { greeting: 0.8, question: 0.2 } },
  score: { type: "score", score: 1.6, confidence: 0.4, legend: { 0: "negative", 1: "neutral", 2: "positive" }, probabilities: { 0: 0.04, 1: 0.31, 2: 0.65 } },
};

// A stubbed http.fetch answer with this status and body.
const httpReply = (status: number, text: string) => (): Reply => ({ value: { status, ok: status < 300, headers: {}, text } });

const answerReply = (type: string): Reply => httpReply(200, JSON.stringify({ model: "jev-1", answers: { answer: ANSWERS[type] }, usage: {} }))();

// Stubs every `$` op the module uses. `env` is explicit (unlisted names are unset); `reply` answers http.fetch.
function setup(on: On, opts: { env: Record<string, string>; reply?: (type: string) => Reply }) {
  const specs: Record<string, unknown>[] = [];
  const fetched: Fetched[] = [];
  mock.env(on, opts.env);
  const clock = mock.clock(on);
  on("tool.register", async (_$, e) => {
    specs.push(e);
    return { value: { tool: TOOL(String(e.name)) } };
  });
  on("http.fetch", (_$, e) => {
    const init = e.init as { method: string; headers: Record<string, string>; body: string };
    const body = JSON.parse(init.body) as Fetched["body"];
    fetched.push({ url: String(e.url), method: init.method, headers: init.headers, body });
    return (opts.reply ?? answerReply)(String(body.questions.answer.type));
  });
  // The engine refuses a session.start answer without { cwd }.
  on("session.start", async (_$, e) => ({ cwd: e.cwd }));
  return { specs, fetched, clock };
}

// Case 1: tools are always registered, whatever the env.
test("session.start registers noul, choice and score without any env var", async ($, on) => {
  const { specs } = setup(on, { env: {} });
  await $.session.start({ cwd: "/proj", surface: "terminal", isInteractive: true });
  expect(specs.map((s) => s.name)).toEqual(["noul", "choice", "score"]);
  expect(specs[0]).toMatchObject({ inputSchema: { type: "object", required: ["instructions", "state"] } });
  expect(specs[1]).toMatchObject({ inputSchema: { required: ["instructions", "state", "criteria"] } });
  expect(specs[2]).toMatchObject({ inputSchema: { required: ["instructions", "state", "criteria"] } });
});

/** The test's `$` (the kit does not export its type). */
type Runner = Parameters<Parameters<typeof test>[2]>[0];

// Valid default input per tool.
const BASE: Record<string, Record<string, unknown>> = {
  noul: { instructions: "Is this text a greeting?", state: "Hello there!", criteria: { true: "a greeting", false: "anything else" } },
  choice: { instructions: "What is this text?", state: "Hello there!", criteria: { greeting: "says hello", question: "asks something" } },
  score: { instructions: "Rate the sentiment", state: "Hello there!", criteria: ["negative", "neutral", "positive"] },
};

const call = ($: Runner, type: string, input: Record<string, unknown> = {}) => $.tool.call({ tool: TOOL(type), ...BASE[type], ...input }) as Promise<{ result?: string; deny?: string }>;

// Errors are a `deny`: the model reads it as an error result (core drops a hook's own isError).
const NO_CONFIG = (type: string) => ({ deny: `${type}: none of TYPESAFE_API_KEY, TYPESAFE_BASE_URL, JEV_URL is set` });

// Cases 2, 3: the env gate runs on every call, sends no request, and blank counts as unset.
for (const type of ["noul", "choice", "score"]) {
  test(`${type} without any env var fails locally`, async ($, on) => {
    const { fetched } = setup(on, { env: {} });
    expect(await call($, type)).toEqual(NO_CONFIG(type));
    expect(fetched).toHaveLength(0);
  });

  test(`${type} with blank env vars fails locally`, async ($, on) => {
    const { fetched } = setup(on, { env: { TYPESAFE_API_KEY: "  ", TYPESAFE_BASE_URL: " ", JEV_URL: "\t" } });
    expect(await call($, type)).toEqual(NO_CONFIG(type));
    expect(fetched).toHaveLength(0);
  });
}

test("the env gate runs before input validation", async ($, on) => {
  setup(on, { env: {} });
  expect(await call($, "noul", { instructions: undefined })).toEqual(NO_CONFIG("noul"));
});

// Case 10: invalid input, exact messages, no request.
test("invalid input is rejected without a request", async ($, on) => {
  const { fetched } = setup(on, { env: { JEV_URL: "https://jev.example/v1/systemone" } });
  const bad = (type: string, input: Record<string, unknown>, message: string) => call($, type, input).then((r) => expect(r).toEqual({ deny: `${type}: ${message}` }));
  await bad("noul", { instructions: undefined }, "instructions must be a non-empty string");
  await bad("noul", { instructions: "   " }, "instructions must be a non-empty string");
  await bad("noul", { state: "  " }, "state must be a non-empty string");
  await bad("noul", { criteria: { maybe: "x" } }, "criteria must be an object with optional string fields true and false");
  await bad("noul", { criteria: { true: 1 } }, "criteria must be an object with optional string fields true and false");
  await bad("noul", { criteria: ["x"] }, "criteria must be an object with optional string fields true and false");
  await bad("noul", { criteria: null }, "criteria must be an object with optional string fields true and false");
  await bad("choice", { criteria: {} }, "criteria must map 1 to 255 non-blank option names to string descriptions");
  await bad("choice", { criteria: { a: 1 } }, "criteria must map 1 to 255 non-blank option names to string descriptions");
  await bad("choice", { criteria: { " ": "x" } }, "criteria must map 1 to 255 non-blank option names to string descriptions");
  await bad("choice", { criteria: undefined }, "criteria must map 1 to 255 non-blank option names to string descriptions");
  await bad("choice", { criteria: Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`o${i}`, "d"])) }, "criteria must map 1 to 255 non-blank option names to string descriptions");
  await bad("score", { criteria: Array.from({ length: 11 }, (_, i) => `l${i}`) }, "criteria must be an array of 2 to 10 strings");
  await bad("score", { criteria: ["only"] }, "criteria must be an array of 2 to 10 strings");
  await bad("score", { criteria: [] }, "criteria must be an array of 2 to 10 strings");
  await bad("score", { criteria: ["a", 2] }, "criteria must be an array of 2 to 10 strings");
  expect(fetched).toHaveLength(0);
});

// Case 14: other tools pass through to the next hook untouched.
test("a call to another tool reaches the next hook unchanged", async ($, on) => {
  setup(on, { env: {} });
  on("tool.call", async (_$, e) => ({ result: e }));
  expect(await $.tool.call({ tool: "Read", file_path: "/x" })).toEqual({ result: { tool: "Read", file_path: "/x" } });
});

const SYSTEMONE = "https://api.typesafe.ai/v1/systemone";

// Case 4: any one of the three variables opens the gate.
for (const env of [{ TYPESAFE_API_KEY: "k" }, { TYPESAFE_BASE_URL: "https://proxy.example" }, { JEV_URL: "https://jev.example/x" }] as Record<string, string>[]) {
  test(`noul sends one request with only ${Object.keys(env)[0]} set`, async ($, on) => {
    const { fetched } = setup(on, { env });
    expect(await call($, "noul")).toEqual({ result: JSON.stringify(ANSWERS.noul) });
    expect(fetched).toHaveLength(1);
  });
}

// Case 5
test("noul posts to the default endpoint with the bearer key", async ($, on) => {
  const { fetched } = setup(on, { env: { TYPESAFE_API_KEY: "test-key" } });
  const res = await call($, "noul");
  expect(fetched).toEqual([
    {
      url: SYSTEMONE,
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test-key" },
      body: { model: "jev-latest", state: "Hello there!", questions: { answer: { type: "noul", instructions: "Is this text a greeting?", criteria: { true: "a greeting", false: "anything else" } } } },
    },
  ]);
  expect(res).toEqual({ result: JSON.stringify({ type: "noul", noul: 0.9 }) });
});

// The key never goes out over plain http: same request, no Authorization header.
test("an http JEV_URL gets the request without the bearer key", async ($, on) => {
  const { fetched } = setup(on, { env: { TYPESAFE_API_KEY: "test-key", JEV_URL: "http://jev.test/v1/systemone" } });
  expect(await call($, "noul")).toEqual({ result: JSON.stringify(ANSWERS.noul) });
  expect(fetched.map((f) => f.headers)).toEqual([{ "Content-Type": "application/json" }]);
});

// tool.call follows the name the engine gave each registration, not only the default prefix.
test("tool.call answers the tool names the engine returned", async ($, on) => {
  // Registered before setup's stub, so it answers first.
  on("tool.register", async (_$, e) => ({ value: { tool: `mcp__other__${String(e.name)}` } }));
  const { fetched } = setup(on, { env: { JEV_URL: "https://jev.test/v1/systemone" } });
  await $.session.start({ cwd: "/proj", surface: "terminal", isInteractive: true });
  for (const type of ["noul", "choice", "score"]) expect(await $.tool.call({ tool: `mcp__other__${type}`, ...BASE[type] })).toEqual({ result: JSON.stringify(ANSWERS[type]) });
  expect(fetched.map((f) => [f.url, f.body.questions.answer.type])).toEqual(["noul", "choice", "score"].map((type) => ["https://jev.test/v1/systemone", type]));
});

// Only an mcp__<plugin>__<type> answer is followed: anything else must not make the hook claim (or crash on) another tool.
test("session.start ignores a tool.register answer that names no own tool", async ($, on) => {
  const answers: Record<string, unknown> = { noul: { tool: "Bash" }, choice: undefined, score: { tool: "mcp__other__score" } };
  on("tool.register", async (_$, e) => ({ value: answers[String(e.name)] }));
  setup(on, { env: { JEV_URL: "https://jev.test/v1/systemone" } });
  on("tool.call", async () => ({ result: "from-next" }));
  await $.session.start({ cwd: "/proj", surface: "terminal", isInteractive: true });
  expect(await $.tool.call({ tool: "Bash", command: "ls" })).toEqual({ result: "from-next" });
  expect(await $.tool.call({ tool: "mcp__other__score", ...BASE.score })).toEqual({ result: JSON.stringify(ANSWERS.score) });
});

// A failed registration is logged, the others still register.
test("a failing tool.register is logged and does not stop the others", async ($, on) => {
  const registered: string[] = [];
  const logs: string[] = [];
  on("tool.register", async (_$, e) => {
    if (e.name === "choice") throw new Error("boom");
    registered.push(String(e.name));
    return { value: { tool: TOOL(String(e.name)) } };
  });
  on("ui.log", async (_$, e) => (logs.push(String(e.text)), { value: undefined }));
  on("session.start", async (_$, e) => ({ cwd: e.cwd }));
  await $.session.start({ cwd: "/proj", surface: "terminal", isInteractive: true });
  expect(registered).toEqual(["noul", "score"]);
  // The engine itself starts the line with the plugin's name.
  expect(logs).toEqual([expect.stringMatching(/^registering choice failed: /)]);
});

// Case 6
for (const type of ["choice", "score"]) {
  test(`${type} sends its criteria and returns the answer object`, async ($, on) => {
    const { fetched } = setup(on, { env: { TYPESAFE_API_KEY: "k" } });
    const res = await call($, type);
    expect(fetched[0]?.body.questions.answer).toEqual({ type, instructions: BASE[type]?.instructions, criteria: BASE[type]?.criteria });
    expect(res).toEqual({ result: JSON.stringify(ANSWERS[type]) });
    expect(JSON.parse(String(res.result))).toHaveProperty("probabilities");
  });
}

// Case 7: endpoint precedence and validation.
test("JEV_URL wins over TYPESAFE_BASE_URL", async ($, on) => {
  const { fetched } = setup(on, { env: { JEV_URL: " https://jev.example/route ", TYPESAFE_BASE_URL: "https://proxy.example" } });
  await call($, "noul");
  expect(fetched[0]?.url).toBe("https://jev.example/route");
});

test("TYPESAFE_BASE_URL gets /v1/systemone appended and trailing slashes dropped", async ($, on) => {
  const { fetched } = setup(on, { env: { TYPESAFE_BASE_URL: "https://proxy.example//" } });
  await call($, "noul");
  expect(fetched[0]?.url).toBe("https://proxy.example/v1/systemone");
});

// An invalid set URL is an error naming the variable and sends nothing.
const URL_RULE: Record<string, string> = { JEV_URL: "an http(s) URL", TYPESAFE_BASE_URL: "an http(s) URL without query or fragment" };
for (const [name, value] of [["JEV_URL", "ftp://x"], ["TYPESAFE_BASE_URL", "ftp://x"], ["TYPESAFE_BASE_URL", "https://h/api?tenant=x"], ["TYPESAFE_BASE_URL", "https://h/api#frag"]]) {
  test(`${name}=${value} is an error and sends nothing`, async ($, on) => {
    const a = setup(on, { env: { [name]: value } });
    expect(await call($, "noul")).toEqual({ deny: `noul: ${name} must be ${URL_RULE[name]}` });
    expect(a.fetched).toHaveLength(0);
  });
}

test("a 2xx non-JSON body is reported as invalid JSON", async ($, on) => {
  setup(on, { env: { TYPESAFE_API_KEY: "k" }, reply: httpReply(200, "<html>") });
  expect(await call($, "noul")).toEqual({ deny: "noul: HTTP 200 response was not valid JSON" });
});

// Case 8
test("TYPESAFE_DEFAULT_MODEL overrides the model", async ($, on) => {
  const { fetched } = setup(on, { env: { TYPESAFE_API_KEY: "k", TYPESAFE_DEFAULT_MODEL: " jev-test " } });
  await call($, "noul");
  expect(fetched[0]?.body.model).toBe("jev-test");
});

// Case 9
test("no TYPESAFE_API_KEY means no Authorization header", async ($, on) => {
  const { fetched } = setup(on, { env: { JEV_URL: "https://jev.example/x" } });
  await call($, "noul");
  expect(fetched[0]?.headers).toEqual({ "Content-Type": "application/json" });
});

// Case 11: HTTP errors with the API's detail.
test("HTTP 400 returns the detail string", async ($, on) => {
  setup(on, { env: { TYPESAFE_API_KEY: "k" }, reply: httpReply(400, JSON.stringify({ detail: "bad" })) });
  expect(await call($, "noul")).toEqual({ deny: "noul: HTTP 400: bad" });
});

test("HTTP 422 returns the stringified detail array", async ($, on) => {
  const detail = [{ loc: ["body", "state"], msg: "field required" }];
  setup(on, { env: { TYPESAFE_API_KEY: "k" }, reply: httpReply(422, JSON.stringify({ detail })) });
  expect(await call($, "noul")).toEqual({ deny: `noul: HTTP 422: ${JSON.stringify(detail)}` });
});

// The live System One server answers errors as { error: { code, message, type } }.
test("HTTP 400 returns the message of an error object", async ($, on) => {
  const error = { code: 400, message: "model 'no-such-model' not found", type: "invalid_request_error" };
  setup(on, { env: { TYPESAFE_API_KEY: "k" }, reply: httpReply(400, JSON.stringify({ error })) });
  expect(await call($, "noul")).toEqual({ deny: "noul: HTTP 400: model 'no-such-model' not found" });
});

test("HTTP 500 with a non-JSON body returns only the status", async ($, on) => {
  setup(on, { env: { TYPESAFE_API_KEY: "k" }, reply: httpReply(500, "oops") });
  expect(await call($, "noul")).toEqual({ deny: "noul: HTTP 500" });
});

// The engine's fetch errors quote the URL, which may carry a private host or token: the result names the variable instead.
for (
  const [name, value, quoted, shown] of [
    ["JEV_URL", "https://jev.example/x?token=secret", "https://jev.example/x?token=secret", "<JEV_URL>"],
    ["JEV_URL", "https://JEV.example/x", "https://jev.example/x", "<JEV_URL>"],
    ["TYPESAFE_BASE_URL", "https://proxy.example/t0k3n", "https://proxy.example/t0k3n/v1/systemone", "<TYPESAFE_BASE_URL>/v1/systemone"],
  ]
) {
  test(`a failed request does not quote ${name}=${value}`, async ($, on) => {
    setup(on, { env: { [name]: value }, reply: () => ({ deny: `jev-api: $.http.fetch(${quoted}) failed: ECONNREFUSED` }) });
    expect(await call($, "noul")).toEqual({ deny: `noul: jev-api: $.http.fetch(${shown}) failed: ECONNREFUSED` });
  });
}

// Case 12: timeout after 30 s.
test("a hung request times out after 30000ms", async ($, on) => {
  const { clock, fetched } = setup(on, { env: { TYPESAFE_API_KEY: "k" }, reply: () => new Promise<never>(() => {}) });
  const pending = call($, "noul");
  // The module loads by dynamic import (file I/O), which one settle does not wait for: flush until the request is out.
  while (fetched.length === 0) await clock.advance(0);
  await clock.advance(30_000);
  expect(await pending).toEqual({ deny: "noul: timeout after 30000ms" });
});

test("a settled request cancels its timeout timer", async ($, on) => {
  const signals: AbortSignal[] = [];
  // Registered before setup's mock.clock, which it passes the wait on to; cancel() aborts the wait's dispatch.
  on("clock.after", (_$, e, next) => (signals.push(next.signal), next(e)));
  setup(on, { env: { TYPESAFE_API_KEY: "k" } });
  expect(await call($, "noul")).toEqual({ result: JSON.stringify(ANSWERS.noul) });
  expect(signals.map((s) => s.aborted)).toEqual([true]);
});

// Case 13: missing or wrong-type answer.
test("a wrong-type or missing answer is an error", async ($, on) => {
  setup(on, { env: { TYPESAFE_API_KEY: "k" }, reply: httpReply(200, JSON.stringify({ answers: { answer: ANSWERS.score } })) });
  expect(await call($, "noul")).toEqual({ deny: "noul: response had no noul answer" });
});

test("a response without answers is an error", async ($, on) => {
  setup(on, { env: { TYPESAFE_API_KEY: "k" }, reply: httpReply(200, "{}") });
  expect(await call($, "choice")).toEqual({ deny: "choice: response had no choice answer" });
});

// A registered tool that no hook answers fails, so a throw before the answer must still answer.
test("a refused env read still answers the tool", async ($, on) => {
  on("env.get", async () => ({ deny: "env reads blocked" }));
  const { fetched } = setup(on, { env: { JEV_URL: "https://jev.example/x" } });
  expect(await call($, "noul")).toEqual({ deny: "noul: env reads blocked" });
  expect(fetched).toHaveLength(0);
});

// The kit cannot abandon a dispatch, so this drives the hook directly: an abort answers at once although the request hangs.
it("an abandoned call answers at once instead of waiting for the request", async () => {
  const { register } = await import("../plugin/hooks/register.mjs");
  const hooks = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  register((event: string, hook: (...args: unknown[]) => Promise<unknown>) => void hooks.set(event, hook));
  let sent = false;
  const $ = {
    env: { get: async (name: string) => (name === "JEV_URL" ? "https://jev.example/x" : undefined) },
    http: { fetch: () => ((sent = true), new Promise(() => {})) },
    clock: { after: () => ({ cancel() {} }) },
  };
  const ctl = new AbortController();
  const pending = hooks.get("tool.call")?.($, { tool: TOOL("noul"), ...BASE.noul }, Object.assign(async () => ({}), { signal: ctl.signal }));
  while (!sent) await new Promise((r) => setImmediate(r));
  ctl.abort();
  expect(await pending).toEqual({ deny: "noul: the call was abandoned" });
});

// Live smoke tests (opt-in): run against the System One server named by JEV_URL in the shell; skipped without it.
// Nothing is hardcoded: the URL, key and model come only from the environment.
describe.skipIf(!process.env.JEV_URL)("live JEV System One (JEV_URL)", () => {
  /** Forwards the module's http.fetch to the real global fetch; the mock clock is never advanced (no 30 s race). */
  function live(on: On) {
    mock.env(on, { JEV_URL: process.env.JEV_URL, TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY, TYPESAFE_DEFAULT_MODEL: process.env.TYPESAFE_DEFAULT_MODEL });
    mock.clock(on);
    on("tool.register", async (_$, e) => ({ value: { tool: TOOL(String(e.name)) } }));
    on("http.fetch", async (_$, e) => {
      const r = await fetch(String(e.url), e.init as RequestInit);
      return { value: { status: r.status, ok: r.ok, headers: Object.fromEntries(r.headers), text: await r.text() } };
    });
  }

  const answer = async ($: Runner, type: string) => {
    const res = await call($, type);
    expect(res.deny).toBeUndefined();
    const parsed = JSON.parse(String(res.result)) as Record<string, unknown>;
    expect(parsed.type).toBe(type);
    return parsed;
  };

  test("noul answers with a probability", { timeoutMs: 60_000 }, async ($, on) => {
    live(on);
    const { noul } = await answer($, "noul");
    expect(typeof noul).toBe("number");
    expect(noul as number).toBeGreaterThanOrEqual(0);
    expect(noul as number).toBeLessThanOrEqual(1);
  });

  test("choice answers with one of the options", { timeoutMs: 60_000 }, async ($, on) => {
    live(on);
    const { choice } = await answer($, "choice");
    expect(["greeting", "question"]).toContain(choice);
  });

  test("score answers with an expected level", { timeoutMs: 60_000 }, async ($, on) => {
    live(on);
    const { score } = await answer($, "score");
    // An expected level: a fraction between the level indexes, so check the range.
    expect(typeof score).toBe("number");
    expect(score as number).toBeGreaterThanOrEqual(0);
    expect(score as number).toBeLessThanOrEqual(2);
  });
});
