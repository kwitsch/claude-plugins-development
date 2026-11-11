// Kit tests for the built plugin/hooks/register.mjs of jev-api: the three System One tools noul, choice, score.
import { createKit } from "claude-engine-vitest";
import type { On } from "claude-engine-vitest";
import { describe, expect } from "vitest";

const { test, mock } = createKit({ module: new URL("../plugin/hooks/register.mjs", import.meta.url), plugin: "jev-api" });

type Reply = { value: { status: number; ok: boolean; headers: Record<string, string>; text: string } } | Promise<never>;
type Fetched = { url: string; headers: Record<string, string>; body: { model: string; state: string; questions: { answer: Record<string, unknown> } } };

const TOOL = (type: string) => `mcp__jev-api__${type}`;

// The API's answer object per type.
const ANSWERS: Record<string, unknown> = {
  noul: { type: "noul", noul: 0.9 },
  choice: { type: "choice", choice: "greeting", confidence: 0.8, probabilities: { greeting: 0.8, question: 0.2 } },
  score: { type: "score", score: 2, confidence: 0.7, legend: ["negative", "neutral", "positive"], probabilities: [0.1, 0.2, 0.7] },
};

const answerReply = (type: string): Reply => ({
  value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ model: "jev-1", answers: { answer: ANSWERS[type] }, usage: {} }) },
});

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
    const init = e.init as { headers: Record<string, string>; body: string };
    const body = JSON.parse(init.body) as Fetched["body"];
    fetched.push({ url: String(e.url), headers: init.headers, body });
    return (opts.reply ?? answerReply)(String(body.questions.answer.type));
  });
  on("session.start", async () => ({}));
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

const call = ($: Runner, type: string, input: Record<string, unknown> = {}) => $.tool.call({ tool: TOOL(type), ...BASE[type], ...input }) as Promise<{ result?: string; isError?: boolean }>;

const NO_CONFIG = (type: string) => ({ isError: true, result: `${type}: none of TYPESAFE_API_KEY, TYPESAFE_BASE_URL, JEV_URL is set` });

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
  const bad = (type: string, input: Record<string, unknown>, message: string) => call($, type, input).then((r) => expect(r).toEqual({ isError: true, result: `${type}: ${message}` }));
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
  await bad("score", { criteria: Array.from({ length: 11 }, (_, i) => `l${i}`) }, "criteria must be an array of 1 to 10 strings");
  await bad("score", { criteria: [] }, "criteria must be an array of 1 to 10 strings");
  await bad("score", { criteria: ["a", 2] }, "criteria must be an array of 1 to 10 strings");
  expect(fetched).toHaveLength(0);
});

// Case 14: other tools pass through to the next hook untouched.
test("a call to another tool reaches the next hook", async ($, on) => {
  setup(on, { env: {} });
  on("tool.call", async () => ({ result: "from-next" }));
  expect(await $.tool.call({ tool: "Read", file_path: "/x" })).toEqual({ result: "from-next" });
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
      headers: { "Content-Type": "application/json", Authorization: "Bearer test-key" },
      body: { model: "jev-latest", state: "Hello there!", questions: { answer: { type: "noul", instructions: "Is this text a greeting?", criteria: { true: "a greeting", false: "anything else" } } } },
    },
  ]);
  expect(res).toEqual({ result: JSON.stringify({ type: "noul", noul: 0.9 }) });
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

test("a non-http(s) URL is an error naming the variable and sends nothing", async ($, on) => {
  const a = setup(on, { env: { JEV_URL: "ftp://x" } });
  expect(await call($, "noul")).toEqual({ isError: true, result: "noul: JEV_URL must be an http(s) URL" });
  expect(a.fetched).toHaveLength(0);
});

test("a non-http(s) TYPESAFE_BASE_URL is an error naming the variable and sends nothing", async ($, on) => {
  const a = setup(on, { env: { TYPESAFE_BASE_URL: "ftp://x" } });
  expect(await call($, "noul")).toEqual({ isError: true, result: "noul: TYPESAFE_BASE_URL must be an http(s) URL" });
  expect(a.fetched).toHaveLength(0);
});

test("a TYPESAFE_BASE_URL with a query is an error and sends nothing", async ($, on) => {
  const a = setup(on, { env: { TYPESAFE_BASE_URL: "https://h/api?tenant=x" } });
  expect(await call($, "noul")).toEqual({ isError: true, result: "noul: TYPESAFE_BASE_URL must be an http(s) URL" });
  expect(a.fetched).toHaveLength(0);
});

test("a 2xx non-JSON body is reported as invalid JSON", async ($, on) => {
  setup(on, { env: { TYPESAFE_API_KEY: "k" }, reply: () => ({ value: { status: 200, ok: true, headers: {}, text: "<html>" } }) });
  expect(await call($, "noul")).toEqual({ isError: true, result: "noul: HTTP 200 response was not valid JSON" });
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
const httpReply = (status: number, text: string) => (): Reply => ({ value: { status, ok: false, headers: {}, text } });

test("HTTP 400 returns the detail string", async ($, on) => {
  setup(on, { env: { TYPESAFE_API_KEY: "k" }, reply: httpReply(400, JSON.stringify({ detail: "bad" })) });
  expect(await call($, "noul")).toEqual({ isError: true, result: "noul: HTTP 400: bad" });
});

test("HTTP 422 returns the stringified detail array", async ($, on) => {
  const detail = [{ loc: ["body", "state"], msg: "field required" }];
  setup(on, { env: { TYPESAFE_API_KEY: "k" }, reply: httpReply(422, JSON.stringify({ detail })) });
  expect(await call($, "noul")).toEqual({ isError: true, result: `noul: HTTP 422: ${JSON.stringify(detail)}` });
});

test("HTTP 500 with a non-JSON body returns only the status", async ($, on) => {
  setup(on, { env: { TYPESAFE_API_KEY: "k" }, reply: httpReply(500, "oops") });
  expect(await call($, "noul")).toEqual({ isError: true, result: "noul: HTTP 500" });
});

// Case 12: timeout after 30 s.
test("a hung request times out after 30000ms", async ($, on) => {
  const { clock, fetched } = setup(on, { env: { TYPESAFE_API_KEY: "k" }, reply: () => new Promise<never>(() => {}) });
  const pending = call($, "noul");
  // The module loads by dynamic import (file I/O), which one settle does not wait for: flush until the request is out.
  while (fetched.length === 0) await clock.advance(0);
  await clock.advance(30_000);
  expect(await pending).toEqual({ isError: true, result: "noul: timeout after 30000ms" });
});

// Case 13: missing or wrong-type answer, unparsable body.
test("a wrong-type or missing answer is an error", async ($, on) => {
  const text = (body: unknown) => (): Reply => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } });
  setup(on, { env: { TYPESAFE_API_KEY: "k" }, reply: text({ answers: { answer: ANSWERS.score } }) });
  expect(await call($, "noul")).toEqual({ isError: true, result: "noul: response had no noul answer" });
});

test("a response without answers is an error", async ($, on) => {
  setup(on, { env: { TYPESAFE_API_KEY: "k" }, reply: () => ({ value: { status: 200, ok: true, headers: {}, text: "{}" } }) });
  expect(await call($, "choice")).toEqual({ isError: true, result: "choice: response had no choice answer" });
});

test("an unparsable 200 body is reported with the parse error", async ($, on) => {
  setup(on, { env: { TYPESAFE_API_KEY: "k" }, reply: () => ({ value: { status: 200, ok: true, headers: {}, text: "not json" } }) });
  const res = await call($, "noul");
  expect(res.isError).toBe(true);
  expect(res.result).toMatch(/^noul: /);
});

// Live smoke tests (opt-in): run against the System One server named by JEV_URL in the shell; skipped without it.
// Nothing is hardcoded: the URL, key and model come only from the environment.
describe.skipIf(!process.env.JEV_URL)("live JEV System One (JEV_URL)", () => {
  /** Forwards the module's http.fetch to the real global fetch; the mock clock is never advanced (no 30 s race). */
  function live(on: On) {
    const env = Object.fromEntries(
      Object.entries({ JEV_URL: process.env.JEV_URL, TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY, TYPESAFE_DEFAULT_MODEL: process.env.TYPESAFE_DEFAULT_MODEL }).filter(([, v]) => v !== undefined && v !== ""),
    ) as Record<string, string>;
    mock.env(on, env);
    mock.clock(on);
    on("tool.register", async (_$, e) => ({ value: { tool: TOOL(String(e.name)) } }));
    on("http.fetch", async (_$, e) => {
      const r = await fetch(String(e.url), e.init as RequestInit);
      return { value: { status: r.status, ok: r.ok, headers: Object.fromEntries(r.headers), text: await r.text() } };
    });
  }

  const answer = async ($: Runner, type: string) => {
    const res = await call($, type);
    expect(res.isError).toBeFalsy();
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

  test("score answers with a level index", { timeoutMs: 60_000 }, async ($, on) => {
    live(on);
    const { score } = await answer($, "score");
    // The live server returns an expected level (a fraction between the indexes), not a whole index: check the range.
    expect(typeof score).toBe("number");
    expect(score as number).toBeGreaterThanOrEqual(0);
    expect(score as number).toBeLessThanOrEqual(2);
  });
});
