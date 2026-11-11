// Kit tests for the built plugin/hooks/register.mjs of jev-api: the three System One tools noul, choice, score.
import { createKit } from "claude-engine-vitest";
import type { On } from "claude-engine-vitest";
import { expect } from "vitest";

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
  await bad("choice", { criteria: {} }, "criteria must map 1 to 255 option names to string descriptions");
  await bad("choice", { criteria: { a: 1 } }, "criteria must map 1 to 255 option names to string descriptions");
  await bad("choice", { criteria: undefined }, "criteria must map 1 to 255 option names to string descriptions");
  await bad("choice", { criteria: Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`o${i}`, "d"])) }, "criteria must map 1 to 255 option names to string descriptions");
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
