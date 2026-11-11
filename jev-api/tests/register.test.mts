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
