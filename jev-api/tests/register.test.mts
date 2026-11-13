// Kit tests for the built plugin/hooks/register.mjs of jev-api: the System One tools noul, choice, score and batch.
import { createKit } from "claude-engine-vitest";
import type { On } from "claude-engine-vitest";
import { describe, expect, it, vi } from "vitest";

const { test, mock } = createKit({ module: new URL("../plugin/hooks/register.mjs", import.meta.url), plugin: "jev-api" });

type Reply = { value: { status: number; ok: boolean; headers: Record<string, string>; text: string } } | { deny: string } | Promise<never>;
type Fetched = { url: string; method: string; headers: Record<string, string>; body: { model: string; state: string; questions: Record<string, Record<string, unknown>> } };

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
    return (opts.reply ?? answerReply)(String(body.questions.answer?.type));
  });
  // The engine refuses a session.start answer without { cwd }.
  on("session.start", async (_$, e) => ({ cwd: e.cwd }));
  return { specs, fetched, clock };
}

// Case 1: tools are always registered, whatever the env.
test("session.start registers noul, choice, score and batch without any env var", async ($, on) => {
  const { specs } = setup(on, { env: {} });
  await $.session.start({ cwd: "/proj", surface: "terminal", isInteractive: true });
  expect(specs.map((s) => s.name)).toEqual(["noul", "choice", "score", "batch"]);
  expect(specs[3]).toMatchObject({ inputSchema: { required: ["state", "questions"] } });
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
// Without any env var (blank counts as unset) Haiku, through `$.model.complete`, answers instead of System One.
type Completion = { value: { isAnswered: true; text: string; usage: Record<string, number> } } | { value: { isAnswered: false; reason: string } };
const said = (text: string): Completion => ({ value: { isAnswered: true, text, usage: { input_tokens: 1, output_tokens: 1 } } });

/** Stubs model.complete with `reply`, recording each request. */
function haiku(on: On, reply: () => Completion) {
  const asked: Record<string, unknown>[] = [];
  on("model.complete", (_$, e) => {
    asked.push(e);
    return reply();
  });
  return asked;
}

const HAIKU_ANSWERS: Record<string, unknown> = {
  noul: { type: "noul", noul: 0.9 },
  choice: { type: "choice", choice: "greeting", confidence: 0.8, probabilities: { greeting: 0.8, question: 0.2 } },
  // Haiku's own `score` is ignored: the score is derived from the probabilities (here 0.2 + 2 * 0.7 = 1.6).
  score: { type: "score", score: 3, confidence: 0.4, probabilities: { 0: 0.1, 1: 0.2, 2: 0.7 } },
};

// What the tool returns for those answers: noul stretched away from 0.5 (logit x 2.5: 0.9 -> 0.9959), score derived.
const CALIBRATED: Record<string, unknown> = {
  noul: { type: "noul", noul: 0.9959 },
  choice: HAIKU_ANSWERS["choice"],
  score: { type: "score", score: 1.6, confidence: 0.4, legend: { 0: "negative", 1: "neutral", 2: "positive" }, probabilities: { 0: 0.1, 1: 0.2, 2: 0.7 } },
};

for (const type of ["noul", "choice", "score"]) {
  test(`${type} without any env var (or blank ones) is answered by Haiku, no System One request`, async ($, on) => {
    const { fetched } = setup(on, { env: { TYPESAFE_API_KEY: "  ", JEV_URL: "\t" } });
    const asked = haiku(on, () => said("```json\n" + JSON.stringify({ answers: { answer: HAIKU_ANSWERS[type] } }) + "\n```"));
    const r = await call($, type);
    expect(JSON.parse(r.result ?? "null")).toMatchObject(CALIBRATED[type] as object);
    expect(fetched).toHaveLength(0);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ model: "claude-haiku-5-5" });
    expect(String(asked[0]["prompt"])).toContain("Hello there!");
  });
}

test("batch without any env var is answered by Haiku in question order", async ($, on) => {
  setup(on, { env: {} });
  haiku(on, () => said(JSON.stringify({ answers: { q0: HAIKU_ANSWERS["noul"], q1: HAIKU_ANSWERS["choice"] } })));
  const r = (await $.tool.call({ tool: TOOL("batch"), state: "Hello", questions: [{ type: "noul", instructions: "Greeting?" }, { type: "choice", instructions: "What?", criteria: { greeting: "hi", question: "?" } }] })) as { result?: string };
  expect(JSON.parse(r.result ?? "null")).toEqual([CALIBRATED["noul"], CALIBRATED["choice"]]);
});

test("a Haiku reply that does not fit the System One format is an error, never a made-up answer", async ($, on) => {
  setup(on, { env: {} });
  let text = "";
  haiku(on, () => said(text));
  const bad = async (reply: unknown, type = "noul") => {
    text = typeof reply === "string" ? reply : JSON.stringify({ answers: { answer: reply } });
    expect((await call($, type)).deny).toMatch(new RegExp(`^${type}: fallback`));
  };
  await bad("not json");
  await bad("{}");
  await bad({ type: "noul", noul: 1.5 });
  await bad({ type: "score", noul: 0.5 });
  await bad({ type: "choice", choice: "other", confidence: 1, probabilities: { greeting: 1 } }, "choice");
  await bad({ type: "score", confidence: 1, probabilities: { 0: 0, 1: 0, 2: 0 } }, "score");
});

test("Haiku's noul is stretched away from 0.5 and its score is the mean of its normalized probabilities", async ($, on) => {
  setup(on, { env: {} });
  let reply: unknown;
  haiku(on, () => said(JSON.stringify({ answers: { answer: reply } })));
  const ask = async (type: string, answer: unknown) => {
    reply = answer;
    return JSON.parse((await call($, type)).result ?? "null") as Record<string, unknown>;
  };
  expect((await ask("noul", { type: "noul", noul: 0.5 }))["noul"]).toBe(0.5);
  expect((await ask("noul", { type: "noul", noul: 0.1 }))["noul"]).toBe(0.0041);
  expect((await ask("noul", { type: "noul", noul: 0.8 }))["noul"]).toBeGreaterThan(0.95);
  // Probabilities that sum to 2 are normalized: mean (0.5 + 2 * 1) / 2 = 1.25; Haiku's own score of 4 is ignored.
  expect(await ask("score", { type: "score", score: 4, confidence: 0.5, probabilities: { 0: 0.5, 1: 0.5, 2: 1 } })).toMatchObject({ score: 1.25, probabilities: { 0: 0.25, 1: 0.25, 2: 0.5 } });
});

test("the Haiku prompt carries the calibration guidance", async ($, on) => {
  setup(on, { env: {} });
  const asked = haiku(on, () => said(JSON.stringify({ answers: { answer: HAIKU_ANSWERS["noul"] } })));
  await call($, "noul");
  expect(String(asked[0]["system"])).toMatch(/calibrated estimator/);
  expect(String(asked[0]["system"])).toMatch(/lowest level that fully handles the case/);
});

test("Haiku not answering is an error", async ($, on) => {
  setup(on, { env: {} });
  haiku(on, () => ({ value: { isAnswered: false, reason: "down" } }));
  expect((await call($, "noul")).deny).toBe("noul: fallback: down");
});

test("the Haiku fallback still validates input first", async ($, on) => {
  setup(on, { env: {} });
  const asked = haiku(on, () => said("{}"));
  expect(await call($, "noul", { instructions: undefined })).toEqual({ deny: "noul: instructions must be a non-empty string" });
  expect(asked).toHaveLength(0);
});

test("a configured Jev that fails is an error, not a Haiku fallback", async ($, on) => {
  setup(on, { env: { JEV_URL: "https://jev.example/v1/systemone" }, reply: httpReply(500, "{}") });
  const asked = haiku(on, () => said("{}"));
  expect((await call($, "noul")).deny).toMatch(/^noul: HTTP 500/);
  expect(asked).toHaveLength(0);
});

test("a tool call before session.start registers the tools once", async ($, on) => {
  const { specs } = setup(on, { env: {} });
  haiku(on, () => said(JSON.stringify({ answers: { answer: HAIKU_ANSWERS["noul"] } })));
  await call($, "noul");
  await call($, "noul");
  expect(specs.map((s) => s.name)).toEqual(["noul", "choice", "score", "batch"]);
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
  expect(registered).toEqual(["noul", "score", "batch"]);
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
for (
  const [name, value] of [
    ["JEV_URL", "ftp://x"],
    ["JEV_URL", "not a url"],
    ["JEV_URL", "file:///etc/passwd"],
    ["JEV_URL", "https://"],
    ["JEV_URL", "https://a b/x"],
    ["TYPESAFE_BASE_URL", "ftp://x"],
    ["TYPESAFE_BASE_URL", "https://h/api?tenant=x"],
    ["TYPESAFE_BASE_URL", "https://h/api#frag"],
  ]
) {
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

// Case 12: the timeout is the call's `timeout` in seconds, else the `timeout` option, else 20 s; invalid values fall through.
/**
 * Calls a tool against a request that never answers and checks that the call times out after exactly `ms`.
 *
 * @param $ - The test's engine.
 * @param on - The test's hook registrar.
 * @param ms - The expected timeout in milliseconds.
 * @param input - Input fields merged over the tool's default input.
 * @param type - The tool to call.
 */
async function timesOutAfter($: Runner, on: On, ms: number, input: Record<string, unknown> = {}, type = "noul") {
  const { clock, fetched } = setup(on, { env: { TYPESAFE_API_KEY: "k" }, reply: () => new Promise<never>(() => {}) });
  let settled = false;
  const pending = call($, type, input).finally(() => (settled = true));
  // The module loads by dynamic import (file I/O), which one settle does not wait for: flush until the request is out.
  while (fetched.length === 0) await clock.advance(0);
  await clock.advance(ms - 1);
  expect(settled).toBe(false);
  await clock.advance(1);
  expect(await pending).toEqual({ deny: `${type}: timeout after ${ms}ms` });
}

test("a hung request times out after the default 20 s", async ($, on) => {
  await timesOutAfter($, on, 20_000);
});

test("a call's timeout sets the request timeout in seconds", async ($, on) => {
  await timesOutAfter($, on, 5000, { timeout: 5 });
});

test("batch takes a timeout too", async ($, on) => {
  await timesOutAfter($, on, 2000, { timeout: 2 }, "batch");
});

test("without a call timeout the timeout option applies", { options: { timeout: 7 } }, async ($, on) => {
  await timesOutAfter($, on, 7000);
});

test("a call's timeout wins over the timeout option", { options: { timeout: 7 } }, async ($, on) => {
  await timesOutAfter($, on, 3000, { timeout: 3 });
});

for (const timeout of ["5", 0, -2, true, null]) {
  test(`an invalid call timeout ${JSON.stringify(timeout)} falls back to the timeout option`, { options: { timeout: 7 } }, async ($, on) => {
    await timesOutAfter($, on, 7000, { timeout });
  });
}

for (const timeout of ["10", 0, -1]) {
  test(`an invalid timeout option ${JSON.stringify(timeout)} falls back to 20 s`, { options: { timeout } }, async ($, on) => {
    await timesOutAfter($, on, 20_000);
  });
}

// Above 30 s (the engine's own fetch cap) a timeout counts as 30 s: in ms past 2^31-1 a setTimeout would fire at once.
test("a call's timeout above 30 s counts as 30 s", async ($, on) => {
  await timesOutAfter($, on, 30_000, { timeout: 3_600_000 });
});

test("a timeout option above 30 s counts as 30 s", { options: { timeout: 9_999_999 } }, async ($, on) => {
  await timesOutAfter($, on, 30_000);
});

test("a settled request cancels its timeout timer", async ($, on) => {
  const signals: AbortSignal[] = [];
  // Registered before setup's mock.clock, which it passes the wait on to; cancel() aborts the wait's dispatch.
  on("clock.after", (_$, e, next) => (signals.push(next.signal), next(e)));
  setup(on, { env: { TYPESAFE_API_KEY: "k" } });
  expect(await call($, "noul")).toEqual({ result: JSON.stringify(ANSWERS.noul) });
  // the lazy registration waits behind a timer of its own: every timer, that one too, is cancelled when its wait ends
  expect(signals.length).toBeGreaterThan(0);
  expect(signals.every((s) => s.aborted)).toBe(true);
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

// batch: several questions in one request, keyed q0, q1, ... by index; the answers come back as an array in question order.
/** The default batch questions: the valid default input of noul, choice and score, without `state`. */
const QUESTIONS = (["noul", "choice", "score"] as const).map((type) => {
  const { instructions, criteria } = BASE[type];
  return { type, instructions, criteria };
});
BASE.batch = { state: "Hello there!", questions: QUESTIONS };
/**
 * Calls the batch tool with the default questions.
 *
 * @param $ - The test's engine.
 * @param input - Input fields merged over the default batch input.
 * @returns The tool result.
 */
const batch = ($: Runner, input: Record<string, unknown> = {}) => call($, "batch", input);
/**
 * A stubbed 200 http.fetch answer carrying these answers.
 *
 * @param answers - The answers by question key (`q0`, `q1`, ...).
 * @returns The reply function for `setup`.
 */
const batchReply = (answers: Record<string, unknown>) => httpReply(200, JSON.stringify({ model: "jev-1", answers, usage: {} }));

test("batch sends every question in one request and returns the answers in question order", async ($, on) => {
  const { fetched } = setup(on, { env: { TYPESAFE_API_KEY: "k" }, reply: batchReply({ q2: ANSWERS.score, q0: ANSWERS.noul, q1: ANSWERS.choice }) });
  expect(await batch($)).toEqual({ result: JSON.stringify([ANSWERS.noul, ANSWERS.choice, ANSWERS.score]) });
  expect(fetched).toHaveLength(1);
  expect(fetched[0].body).toEqual({ model: "jev-latest", state: "Hello there!", questions: { q0: QUESTIONS[0], q1: QUESTIONS[1], q2: QUESTIONS[2] } });
});

test("batch: one missing or wrong-type answer fails the whole call", async ($, on) => {
  setup(on, { env: { TYPESAFE_API_KEY: "k" }, reply: batchReply({ q0: ANSWERS.noul, q1: ANSWERS.score, q2: ANSWERS.score }) });
  expect(await batch($)).toEqual({ deny: "batch: response had no choice answer for questions[1]" });
});

test("batch: an HTTP error is prefixed with batch", async ($, on) => {
  setup(on, { env: { TYPESAFE_API_KEY: "k" }, reply: httpReply(503, "") });
  expect(await batch($)).toEqual({ deny: "batch: HTTP 503" });
});

test("batch: invalid input names the question and sends nothing", async ($, on) => {
  const { fetched } = setup(on, { env: { TYPESAFE_API_KEY: "k" } });
  expect(await batch($, { state: " " })).toEqual({ deny: "batch: state must be a non-empty string" });
  expect(await batch($, { questions: [] })).toEqual({ deny: "batch: questions must be a non-empty array" });
  expect(await batch($, { questions: "noul" })).toEqual({ deny: "batch: questions must be a non-empty array" });
  expect(await batch($, { questions: [QUESTIONS[0], { type: "rank", instructions: "x" }] })).toEqual({ deny: "batch: questions[1]: type must be one of noul, choice, score" });
  expect(await batch($, { questions: [QUESTIONS[0], null] })).toEqual({ deny: "batch: questions[1]: type must be one of noul, choice, score" });
  expect(await batch($, { questions: [{ ...QUESTIONS[2], criteria: ["only"] }] })).toEqual({ deny: "batch: questions[0]: criteria must be an array of 2 to 10 strings" });
  expect(await batch($, { questions: [{ type: "noul", instructions: "" }] })).toEqual({ deny: "batch: questions[0]: instructions must be a non-empty string" });
  expect(fetched).toHaveLength(0);
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

/** The module's hooks driven directly (the kit cannot abandon a dispatch, count listeners or leave a registration pending). */
async function direct(overrides: Record<string, unknown>) {
  const { register } = await import("../plugin/hooks/register.mjs");
  const hooks = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  register((event: string, hook: (...args: unknown[]) => Promise<unknown>) => void hooks.set(event, hook));
  const fetched: unknown[] = [];
  const $ = {
    env: { get: async (name: string) => (name === "TYPESAFE_API_KEY" ? "k" : undefined) },
    http: { fetch: (...a: unknown[]) => (fetched.push(a), Promise.resolve({ status: 200, ok: true, headers: {}, text: JSON.stringify({ answers: { answer: ANSWERS["noul"] } }) })) },
    clock: { after: () => ({ cancel() {} }) },
    ...overrides,
  };
  const run = (type: string, signal: unknown = new AbortController().signal) => hooks.get("tool.call")?.($, { tool: TOOL(type), ...BASE[type] }, Object.assign(async () => ({}), { signal })) as Promise<{ result?: string; deny?: string }>;
  return { run, fetched, hooks, $ };
}

// F02: a tool whose registration failed is registered again by the next hook, the others are not registered twice.
it("a failed registration is retried by the next call, only for the tools still missing", async () => {
  const tries: string[] = [];
  let failBatch = true;
  const { run } = await direct({
    tool: {
      register: async (spec: { name: string }) => {
        tries.push(spec.name);
        if (spec.name === "batch" && failBatch) throw new Error("boom");
        return { tool: TOOL(spec.name) };
      },
    },
    ui: { log: async () => undefined },
  });
  await run("noul");
  expect(tries).toEqual(["noul", "choice", "score", "batch"]);
  failBatch = false;
  await run("noul");
  expect(tries).toEqual(["noul", "choice", "score", "batch", "batch"]);
  await run("noul");
  expect(tries).toHaveLength(5); // nothing is missing any more
});

// F03: a registration that never answers must not hold the call.
it("a registration that never answers does not hold the call", async () => {
  const { run, fetched } = await direct({
    tool: { register: () => new Promise(() => {}) },
    clock: {
      after: (ms: number, fn: () => void) => {
        const t = ms === 1000 ? setTimeout(fn, 0) : undefined;
        return { cancel: () => clearTimeout(t) };
      },
    },
  });
  expect(await run("noul")).toEqual({ result: JSON.stringify(ANSWERS["noul"]) });
  expect(fetched).toHaveLength(1);
});

// F16: one tool whose registration hangs is waited for once; the other tools and later calls do not wait for it again.
it("a hanging registration of one tool is waited for once, not by every call", async () => {
  const waits: number[] = [];
  const { run } = await direct({
    tool: { register: (spec: { name: string }) => (spec.name === "score" ? new Promise(() => {}) : Promise.resolve({ tool: TOOL(spec.name) })) },
    clock: {
      after: (ms: number, fn: () => void) => {
        waits.push(ms);
        const t = ms === 1000 ? setTimeout(fn, 0) : undefined;
        return { cancel: () => clearTimeout(t) };
      },
    },
  });
  for (let i = 0; i < 4; i++) expect(await run("noul")).toEqual({ result: JSON.stringify(ANSWERS["noul"]) });
  expect(waits.filter((ms) => ms === 1000)).toHaveLength(1);
});

// F17: a tool the engine keeps refusing is retried once at once, then with a growing delay, and logged once.
it("a permanently failing registration is retried with back-off and logged once", async () => {
  const tries: string[] = [];
  const logs: string[] = [];
  const { run } = await direct({
    tool: {
      register: async (spec: { name: string }) => {
        tries.push(spec.name);
        if (spec.name === "batch") throw new Error("refused");
        return { tool: TOOL(spec.name) };
      },
    },
    ui: { log: async (text: string) => void logs.push(text) },
  });
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    for (let i = 0; i < 20; i++) await run("noul");
    expect(tries.filter((n) => n === "batch")).toHaveLength(2); // the first try and the immediate retry
    vi.setSystemTime(Date.now() + 6000);
    await run("noul");
    expect(tries.filter((n) => n === "batch")).toHaveLength(3); // after 5 s the next try
    for (let i = 0; i < 5; i++) await run("noul");
    expect(tries.filter((n) => n === "batch")).toHaveLength(3); // the next delay is 10 s
  } finally {
    vi.useRealTimers();
  }
  expect(logs).toHaveLength(1);
});

// F18: the Haiku call carries the abort signal as an option of $.model.complete (the second argument; the request has no signal field).
it("the Haiku call gets the abort signal as an option", async () => {
  const calls: unknown[][] = [];
  const { run } = await direct({
    env: { get: async () => undefined },
    model: { complete: (...a: unknown[]) => (calls.push(a), Promise.resolve({ isAnswered: true, text: "{}", usage: {} })) },
    tool: { register: async (s: { name: string }) => ({ tool: TOOL(s.name) }) },
  });
  const ctl = new AbortController();
  await run("noul", ctl.signal);
  expect(calls).toHaveLength(1);
  expect((calls[0][0] as Record<string, unknown>)["signal"]).toBeUndefined();
  expect((calls[0][1] as { signal?: AbortSignal }).signal).toBe(ctl.signal);
});

// A Haiku choice answer is normalized like a score: the probabilities sum to 1.
test("Haiku choice probabilities are normalized", async ($, on) => {
  haiku(on, () => said(JSON.stringify({ answers: { answer: { type: "choice", choice: "greeting", confidence: 0.8, probabilities: { greeting: 0.97, question: 0.195 } } } })));
  mock.env(on, {});
  const r = await call($, "choice");
  const answer = JSON.parse(r.result ?? "{}") as { probabilities: Record<string, number> };
  expect(answer.probabilities["greeting"]).toBeCloseTo(0.8325, 3);
  expect(answer.probabilities["greeting"] + answer.probabilities["question"]).toBeCloseTo(1, 3);
});

// D3: $.model.complete refuses a timeoutMs that is not a positive whole number; 2.01 s * 1000 is 2009.9999999999998.
test("the Haiku timeout is a whole number of milliseconds", async ($, on) => {
  const asked = haiku(on, () => said("{}"));
  mock.env(on, {});
  await call($, "noul", { timeout: 2.01 });
  await call($, "noul", { timeout: 0.0004 });
  expect(asked.map((r) => r["timeoutMs"])).toEqual([2010, 1]);
});

// D1: the key never reaches the model, not even in the text of a runtime that rejects the header value.
it("an error that quotes the bearer key is redacted", async () => {
  const key = "sk-SECRET-1234567890";
  const { run } = await direct({
    env: { get: async (n: string) => (n === "JEV_URL" ? "https://jev.example/x" : n === "TYPESAFE_API_KEY" ? key : undefined) },
    http: { fetch: () => Promise.reject(new Error(`Header 'Authorization' has invalid value: 'Bearer ${key}\nX'`)) },
    tool: { register: async (s: { name: string }) => ({ tool: TOOL(s.name) }) },
  });
  const r = await run("noul");
  expect(r.deny).toMatch(/^noul: /);
  expect(r.deny).not.toContain(key);
  expect(r.deny).toContain("<TYPESAFE_API_KEY>");
});

// D4: a DNS failure quotes the bare host of the endpoint (live on 2.1.325), which is redacted too.
it("a DNS error that quotes the bare host is redacted", async () => {
  const { run } = await direct({
    env: { get: async (n: string) => (n === "JEV_URL" ? "https://secret-host-zq82.invalid/route/sys?token=TOK" : n === "TYPESAFE_API_KEY" ? "k" : undefined) },
    http: { fetch: () => Promise.reject(new Error("$.http.fetch(https://secret-host-zq82.invalid/route/sys?token=TOK) failed: getaddrinfo ENOTFOUND secret-host-zq82.invalid")) },
    tool: { register: async (s: { name: string }) => ({ tool: TOOL(s.name) }) },
  });
  const r = await run("noul");
  expect(r.deny).not.toContain("secret-host-zq82");
  expect(r.deny).not.toContain("TOK");
  expect(r.deny).toContain("ENOTFOUND <host>");
});

// D5: the redaction order and reach: a key that contains the host text, and a host that is part of ordinary words.
it("redaction: a key containing the host is replaced whole, a host inside other words is kept", async () => {
  const key = "sk-jev-9f8e7d6c5b4a";
  const { run } = await direct({
    env: { get: async (n: string) => (n === "JEV_URL" ? "https://jev/v1/systemone" : n === "TYPESAFE_API_KEY" ? key : undefined) },
    http: { fetch: () => Promise.resolve({ status: 400, ok: false, headers: {}, text: JSON.stringify({ detail: `bad token Bearer ${key} for model 'jev-latest' on 110.0.0.5, host jev` }) }) },
    tool: { register: async (s: { name: string }) => ({ tool: TOOL(s.name) }) },
  });
  const r = await run("noul");
  expect(r.deny).toBe("noul: HTTP 400: bad token Bearer <TYPESAFE_API_KEY> for model 'jev-latest' on 110.0.0.5, host <host>");
});

// D5 (order): the host step must come after the key step, and the host lookbehind keeps `api.jev` as it is.
it("redaction: a key like jev.<rest> is replaced whole before the host step; api.jev stays", async () => {
  const key = "jev.9f8e7d6c5b4a";
  const { run } = await direct({
    env: { get: async (n: string) => (n === "JEV_URL" ? "https://jev/v1/systemone" : n === "TYPESAFE_API_KEY" ? key : undefined) },
    http: { fetch: () => Promise.resolve({ status: 400, ok: false, headers: {}, text: JSON.stringify({ detail: `bad token Bearer ${key} via api.jev, host jev` }) }) },
    tool: { register: async (s: { name: string }) => ({ tool: TOOL(s.name) }) },
  });
  expect((await run("noul")).deny).toBe("noul: HTTP 400: bad token Bearer <TYPESAFE_API_KEY> via api.jev, host <host>");
});

// IPv6 endpoint: the host carries brackets, the error text quotes the bare address.
it("redaction: an IPv6 endpoint host is hidden without its brackets", async () => {
  const { run } = await direct({
    env: { get: async (n: string) => (n === "JEV_URL" ? "http://[2001:db8::7]:8080/v1/systemone" : undefined) },
    http: { fetch: () => Promise.reject(new Error("connect ECONNREFUSED 2001:db8::7:8080")) },
    tool: { register: async (s: { name: string }) => ({ tool: TOOL(s.name) }) },
  });
  expect((await run("noul")).deny).not.toContain("2001:db8");
});

// F06 (Haiku path): the abort listener is removed there too.
it("settled Haiku calls leave no abort listeners on a shared signal", async () => {
  const { run } = await direct({
    env: { get: async () => undefined },
    model: { complete: () => Promise.resolve({ isAnswered: true, text: "{}", usage: {} }) },
    tool: { register: async (s: { name: string }) => ({ tool: TOOL(s.name) }) },
  });
  let listeners = 0;
  const signal = { aborted: false, addEventListener: () => void listeners++, removeEventListener: () => void listeners-- };
  for (let i = 0; i < 5; i++) await run("noul", signal);
  expect(listeners).toBe(0);
});

// The engine reports its own model timeout as `aborted`: the model must read a timeout, not an interrupt.
it("a Haiku timeout reads as a timeout, an abandoned call as abandoned", async () => {
  const { run } = await direct({
    env: { get: async () => undefined },
    model: { complete: () => Promise.resolve({ isAnswered: false, reason: "aborted" }) },
    tool: { register: async (s: { name: string }) => ({ tool: TOOL(s.name) }) },
  });
  expect((await run("noul")).deny).toMatch(/^noul: fallback: timeout after \d+ms$/);
  const ctl = new AbortController();
  const pending = run("noul", ctl.signal);
  ctl.abort();
  expect((await pending).deny).toBe("noul: the call was abandoned");
});

// The Haiku reply cleanup must not take quadratic time on a long whitespace run.
test("a Haiku reply with a long whitespace run is cleaned in linear time", async ($, on) => {
  const pad = " ".repeat(80_000);
  haiku(on, () => said(`{"answers":{"answer":{"type":"noul","noul":0.5}${pad}}}`));
  mock.env(on, {});
  const t0 = Date.now();
  const r = await call($, "noul");
  expect(r.result).toBeDefined();
  expect(Date.now() - t0).toBeLessThan(1000);
});

// D2: an error body a server fills with the request URL is redacted like a fetch error.
it("an error body that echoes the endpoint is redacted", async () => {
  const url = "https://private.example/tenant-42/systemone?token=SECRET";
  const { run } = await direct({
    env: { get: async (n: string) => (n === "JEV_URL" ? url : undefined) },
    http: { fetch: () => Promise.resolve({ status: 404, ok: false, headers: {}, text: JSON.stringify({ detail: `no route for POST ${url}` }) }) },
    tool: { register: async (s: { name: string }) => ({ tool: TOOL(s.name) }) },
  });
  const r = await run("noul");
  expect(r.deny).toBe("noul: HTTP 404: no route for POST <JEV_URL>");
});

// F05: an already abandoned call sends nothing.
it("an already abandoned call sends no request", async () => {
  const { run, fetched } = await direct({ tool: { register: async (s: { name: string }) => ({ tool: TOOL(s.name) }) } });
  const ctl = new AbortController();
  ctl.abort();
  expect(await run("noul", ctl.signal)).toEqual({ deny: "noul: the call was abandoned" });
  expect(fetched).toHaveLength(0);
});

// F06: the abort listeners of settled calls are removed from a signal shared by many calls.
it("settled calls leave no abort listeners on a shared signal", async () => {
  const { run } = await direct({ tool: { register: async (s: { name: string }) => ({ tool: TOOL(s.name) }) } });
  let listeners = 0;
  const signal = { aborted: false, addEventListener: () => void listeners++, removeEventListener: () => void listeners-- };
  for (let i = 0; i < 5; i++) await run("noul", signal);
  expect(listeners).toBe(0);
});

// F07: invalid input is answered before any env read.
it("an invalid call reads no env variable", async () => {
  let reads = 0;
  const { hooks, $ } = await direct({ tool: { register: async (s: { name: string }) => ({ tool: TOOL(s.name) }) }, env: { get: async () => (reads++, undefined) } });
  const r = (await hooks.get("tool.call")?.($, { tool: TOOL("noul"), state: 1 }, Object.assign(async () => ({}), { signal: new AbortController().signal }))) as { deny?: string };
  expect(r.deny).toMatch(/^noul: /);
  expect(reads).toBe(0);
});

// F04: the Haiku output budget grows with the options a choice answer has to list.
test("the Haiku output budget covers a choice with many options", async ($, on) => {
  const asked = haiku(on, () => said("{}"));
  mock.env(on, {});
  const criteria = Object.fromEntries(Array.from({ length: 255 }, (_, i) => [`option number ${i}`, "d"]));
  await call($, "choice", { criteria });
  await call($, "noul");
  expect(Number(asked[0]["maxTokens"])).toBeGreaterThan(4096);
  expect(Number(asked[1]["maxTokens"])).toBe(512); // unchanged for a noul question
});

// Gaps found by mutation testing (round 6a): each test kills at least one mutant of the shipped code.
it("X14 a hanging registration is not started again by later calls", async () => {
  const tries: string[] = [];
  const { run } = await direct({
    tool: { register: (spec: { name: string }) => (tries.push(spec.name), spec.name === "score" ? new Promise(() => {}) : Promise.resolve({ tool: TOOL(spec.name) })) },
    clock: {
      after: (ms: number, fn: () => void) => {
        const t = ms === 1000 ? setTimeout(fn, 0) : undefined;
        return { cancel: () => clearTimeout(t) };
      },
    },
  });
  for (let i = 0; i < 3; i++) await run("noul");
  expect(tries.filter((n) => n === "score")).toHaveLength(1);
});

it("X25 a key inside JEV_URL: the whole URL still becomes <JEV_URL>", async () => {
  const key = "sk-SECRET-1234567890";
  const url = `https://jev.example/tenant-7?key=${key}`;
  const { run } = await direct({
    env: { get: async (n: string) => (n === "JEV_URL" ? url : n === "TYPESAFE_API_KEY" ? key : undefined) },
    http: { fetch: () => Promise.reject(new Error(`$.http.fetch(${url}) failed: ECONNREFUSED`)) },
    tool: { register: async (s: { name: string }) => ({ tool: TOOL(s.name) }) },
  });
  expect((await run("noul")).deny).toBe("noul: $.http.fetch(<JEV_URL>) failed: ECONNREFUSED");
});

it("X27 the bare host is hidden whatever its case", async () => {
  const { run } = await direct({
    env: { get: async (n: string) => (n === "JEV_URL" ? "https://secret-host-zq82.invalid/x" : undefined) },
    http: { fetch: () => Promise.reject(new Error("getaddrinfo ENOTFOUND SECRET-HOST-ZQ82.invalid")) },
    tool: { register: async (s: { name: string }) => ({ tool: TOOL(s.name) }) },
  });
  expect((await run("noul")).deny).toBe("noul: getaddrinfo ENOTFOUND <host>");
});

test("X39 a Haiku choice whose probabilities are all 0 is an error", async ($, on) => {
  setup(on, { env: {} });
  haiku(on, () => said(JSON.stringify({ answers: { answer: { type: "choice", choice: "greeting", confidence: 1, probabilities: { greeting: 0, question: 0 } } } })));
  expect((await call($, "choice")).deny).toMatch(/^choice: fallback/);
});

it("X48 a URL quoted as given (not as the parser spells it) becomes <JEV_URL>", async () => {
  const url = "https://jev.example/a/../tenant-7";
  const { run } = await direct({
    env: { get: async (n: string) => (n === "JEV_URL" ? url : undefined) },
    http: { fetch: () => Promise.reject(new Error(`$.http.fetch(${url}) failed: ECONNREFUSED`)) },
    tool: { register: async (s: { name: string }) => ({ tool: TOOL(s.name) }) },
  });
  expect((await run("noul")).deny).toBe("noul: $.http.fetch(<JEV_URL>) failed: ECONNREFUSED");
});

it("X50 a Haiku call that rejects after it was abandoned raises no unhandled rejection", async () => {
  let rejectIt: ((e: Error) => void) | undefined;
  const { run } = await direct({
    env: { get: async () => undefined },
    model: { complete: () => new Promise((_, rej) => (rejectIt = rej)) },
    tool: { register: async (s: { name: string }) => ({ tool: TOOL(s.name) }) },
  });
  const ctl = new AbortController();
  const pending = run("noul", ctl.signal);
  while (!rejectIt) await new Promise((r) => setImmediate(r));
  ctl.abort();
  expect((await pending).deny).toBe("noul: the call was abandoned");
  const seen: unknown[] = [];
  const h = (e: unknown) => void seen.push(e);
  process.prependListener("unhandledRejection", h);
  rejectIt(new Error("late"));
  await new Promise((r) => setTimeout(r, 20));
  process.off("unhandledRejection", h);
  expect(seen).toHaveLength(0);
});

test("X53 the Haiku output budget is capped at 16384", async ($, on) => {
  const asked = haiku(on, () => said("{}"));
  mock.env(on, {});
  const criteria = Object.fromEntries(Array.from({ length: 255 }, (_, i) => [`${"x".repeat(200)}${i}`, "d"]));
  await call($, "choice", { criteria });
  expect(asked[0]["maxTokens"]).toBe(16384);
});

it("X04 the registration back-off stops growing at 5 minutes", async () => {
  const tries: string[] = [];
  const { run } = await direct({
    tool: {
      register: async (spec: { name: string }) => {
        tries.push(spec.name);
        if (spec.name === "batch") throw new Error("refused");
        return { tool: TOOL(spec.name) };
      },
    },
    ui: { log: async () => undefined },
  });
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const t0 = Date.now();
    for (let i = 0; i < 12; i++) {
      vi.setSystemTime(t0 + 300_001 * i);
      await run("noul");
    }
    expect(tries.filter((n) => n === "batch")).toHaveLength(12); // the delay stops growing
    vi.setSystemTime(t0 + 300_001 * 11 + 200_000);
    await run("noul");
    expect(tries.filter((n) => n === "batch")).toHaveLength(12); // and it is 5 minutes, not less
  } finally {
    vi.useRealTimers();
  }
});

it("X05 the first delayed retry waits 5 s, not less", async () => {
  const tries: string[] = [];
  const { run } = await direct({
    tool: {
      register: async (spec: { name: string }) => {
        tries.push(spec.name);
        if (spec.name === "batch") throw new Error("refused");
        return { tool: TOOL(spec.name) };
      },
    },
    ui: { log: async () => undefined },
  });
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    await run("noul");
    await run("noul"); // immediate retry
    vi.setSystemTime(Date.now() + 4000);
    await run("noul");
  } finally {
    vi.useRealTimers();
  }
  expect(tries.filter((n) => n === "batch")).toHaveLength(2);
});

it("X02 session.start waits up to 5 s for a registration", async () => {
  const waits: number[] = [];
  const { hooks, $ } = await direct({
    tool: { register: () => new Promise(() => {}) },
    clock: {
      after: (ms: number, fn: () => void) => {
        waits.push(ms);
        const t = setTimeout(fn, 0);
        return { cancel: () => clearTimeout(t) };
      },
    },
  });
  await hooks.get("session.start")?.($, { cwd: "/p" }, async () => ({}));
  expect(waits).toEqual([5000]);
});

it("X23 a key shorter than 6 characters is not redacted", async () => {
  const { run } = await direct({
    env: { get: async (n: string) => (n === "JEV_URL" ? "https://jev.example/x" : n === "TYPESAFE_API_KEY" ? "abc" : undefined) },
    http: { fetch: () => Promise.resolve({ status: 400, ok: false, headers: {}, text: JSON.stringify({ detail: "abc is wrong" }) }) },
    tool: { register: async (s: { name: string }) => ({ tool: TOOL(s.name) }) },
  });
  expect((await run("noul")).deny).toBe("noul: HTTP 400: abc is wrong");
});

// F21: an error body of megabytes reaches the model cut, and a key at the cut is gone whole.
it("an oversized error reason is cut after the redaction", async () => {
  const key = "sk-SECRET-1234567890";
  const { run } = await direct({
    env: { get: async (n: string) => (n === "JEV_URL" ? "https://jev.example/x" : n === "TYPESAFE_API_KEY" ? key : undefined) },
    http: { fetch: () => Promise.resolve({ status: 500, ok: false, headers: {}, text: JSON.stringify({ detail: "x".repeat(995) + key + "y".repeat(5_000_000) }) }) },
    tool: { register: async (s: { name: string }) => ({ tool: TOOL(s.name) }) },
  });
  const r = await run("noul");
  expect(r.deny?.length).toBeLessThanOrEqual("noul: HTTP 500: ".length + 1001);
  expect(r.deny).not.toContain("sk-SECRET");
  expect(r.deny).toContain("<TYPESAFE_API_KEY>".slice(0, 5));
});

// A blank reason has no dangling colon, the cut leaves no lone surrogate.
it("a blank error reason adds nothing, a cut astral text stays valid", async () => {
  const reply = (detail: string) =>
    direct({
      env: { get: async (n: string) => (n === "JEV_URL" ? "https://jev.example/x" : undefined) },
      http: { fetch: () => Promise.resolve({ status: 500, ok: false, headers: {}, text: JSON.stringify({ detail }) }) },
      tool: { register: async (s: { name: string }) => ({ tool: TOOL(s.name) }) },
    }).then(({ run }) => run("noul"));
  expect((await reply("  ")).deny).toBe("noul: HTTP 500");
  const cut = (await reply("x" + "😀".repeat(1500))).deny ?? "";
  expect(cut).not.toMatch(/[\uD800-\uDBFF]…$/);
});

// An engine that resolves `aborted` first on an abandoned call still reads as abandoned.
it("a Haiku reply `aborted` with the signal aborted reads as abandoned", async () => {
  const ctl = new AbortController();
  const { run } = await direct({
    env: { get: async () => undefined },
    model: { complete: () => (ctl.abort(), Promise.resolve({ isAnswered: false, reason: "aborted" })) },
    tool: { register: async (s: { name: string }) => ({ tool: TOOL(s.name) }) },
  });
  expect((await run("noul", ctl.signal)).deny).toBe("noul: the call was abandoned");
});

// A log call that never settles must not keep a refused tool from being retried.
it("a hanging ui.log does not keep a failed registration pending", async () => {
  const tries: string[] = [];
  let fail = true;
  const { run } = await direct({
    tool: { register: async (s: { name: string }) => (tries.push(s.name), s.name === "batch" && fail ? Promise.reject(new Error("refused")) : { tool: TOOL(s.name) }) },
    ui: { log: () => new Promise(() => {}) },
  });
  await run("noul");
  fail = false;
  await run("noul");
  expect(tries.filter((n) => n === "batch")).toHaveLength(2);
});

// Gaps found by the second mutation round (round 7a).
it("JJ a DNS error that quotes the bare host of TYPESAFE_BASE_URL is redacted", async () => {
  const { run } = await direct({
    env: { get: async (n: string) => (n === "TYPESAFE_BASE_URL" ? "https://secret-base-zq82.invalid" : undefined) },
    http: { fetch: () => Promise.reject(new Error("getaddrinfo ENOTFOUND secret-base-zq82.invalid")) },
    tool: { register: async (s: { name: string }) => ({ tool: TOOL(s.name) }) },
  });
  expect((await run("noul")).deny).toBe("noul: getaddrinfo ENOTFOUND <host>");
});

it("JJ a key of exactly 6 characters is redacted", async () => {
  const key = "k9Q2x7";
  const { run } = await direct({
    env: { get: async (n: string) => (n === "JEV_URL" ? "https://jev.example/x" : n === "TYPESAFE_API_KEY" ? key : undefined) },
    http: { fetch: () => Promise.reject(new Error(`Header 'Authorization' has invalid value: 'Bearer ${key}\nX'`)) },
    tool: { register: async (s: { name: string }) => ({ tool: TOOL(s.name) }) },
  });
  const r = await run("noul");
  expect(r.deny).not.toContain(key);
  expect(r.deny).toContain("<TYPESAFE_API_KEY>");
});

it("JJ a JEV_URL without a host is an error, not a request", async () => {
  const fetched: string[] = [];
  const { run } = await direct({
    env: { get: async (n: string) => (n === "JEV_URL" ? "https:///v1/systemone" : n === "TYPESAFE_API_KEY" ? "sk-SECRET-1234567890" : undefined) },
    http: { fetch: (url: string) => (fetched.push(url), Promise.reject(new Error("x"))) },
    tool: { register: async (s: { name: string }) => ({ tool: TOOL(s.name) }) },
  });
  expect((await run("noul")).deny).toBe("noul: JEV_URL must be an http(s) URL");
  expect(fetched).toHaveLength(0);
});

test("JJ a blank TYPESAFE_DEFAULT_MODEL counts as unset: jev-latest", async ($, on) => {
  const { fetched } = setup(on, { env: { JEV_URL: "https://jev.example/x", TYPESAFE_DEFAULT_MODEL: "  " } });
  await call($, "noul");
  expect(fetched[0]?.body.model).toBe("jev-latest");
});

for (const [label, wrap] of [["a fenced reply with a trailing newline", (j: string) => "```json\n" + j + "\n```\n"], ["a bare fence", (j: string) => "```\n" + j + "\n```"]] as const) {
  test(`JJ Haiku: ${label} is read`, async ($, on) => {
    setup(on, { env: {} });
    haiku(on, () => said(wrap(JSON.stringify({ answers: { answer: HAIKU_ANSWERS["noul"] } }))));
    const r = await call($, "noul");
    expect(JSON.parse(r.result ?? "null")).toMatchObject(CALIBRATED["noul"] as object);
  });
}

// Live smoke tests (opt-in): run against the System One server named by JEV_URL in the shell; skipped without it.
// Nothing is hardcoded: the URL, key and model come only from the environment.
describe.skipIf(!process.env.JEV_URL)("live JEV System One (JEV_URL)", () => {
  /** Forwards the module's http.fetch to the real global fetch; the mock clock is never advanced (no timeout race). */
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

  test("batch answers all three questions in one request", { timeoutMs: 60_000 }, async ($, on) => {
    live(on);
    const res = await batch($);
    expect(res.deny).toBeUndefined();
    expect((JSON.parse(String(res.result)) as { type: string }[]).map((a) => a.type)).toEqual(["noul", "choice", "score"]);
  });
});
