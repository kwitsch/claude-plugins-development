// Tests of the shared HTTP core of jev-api (plugin/shared/http.mjs): the pure helpers and sendRequest with a fake doFetch.
import { describe, expect, it } from "vitest";
import { contextRefusal, detail, endpoint, hide, hideHost, sendRequest } from "../plugin/shared/http.mjs";

const KEY = "sk-test-key-123456";
const STATE = "A cat sat on the mat.";
const QUESTIONS = { answer: { type: "noul", instructions: "Is it about animals?" } };

type Init = { method: string; headers: Record<string, string>; body: string };
type Reply = { status: number; text: string };

/** A fake doFetch that records its calls and answers (or throws) what it is told. */
const fake = (answer: Reply | Error) => {
  const calls: { url: string; init: Init }[] = [];
  const doFetch = async (url: string, init: Init): Promise<Reply> => {
    calls.push({ url, init });
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { calls, doFetch };
};

/** An Error named as the engine-side callers name theirs. */
const named = (name: string, message: string) => Object.assign(new Error(message), { name });

describe("endpoint", () => {
  it("prefers JEV_URL, then the base plus /v1/systemone with trailing slashes cut, then the default", () => {
    expect(endpoint("https://j.example/route", "https://b.example")).toEqual({ ok: true, url: "https://j.example/route" });
    expect(endpoint(undefined, "https://b.example///")).toEqual({ ok: true, url: "https://b.example/v1/systemone" });
    expect(endpoint(undefined, undefined)).toEqual({ ok: true, url: "https://api.typesafe.ai/v1/systemone" });
  });
  it("refuses an invalid set value instead of falling back", () => {
    expect(endpoint("ftp://x", "https://b.example")).toEqual({ ok: false, error: "JEV_URL must be an http(s) URL" });
    expect(endpoint(undefined, "https://b.example/?q=1")).toEqual({ ok: false, error: "TYPESAFE_BASE_URL must be an http(s) URL without query or fragment" });
    expect(endpoint(undefined, "https://b.example/#f")).toMatchObject({ ok: false });
  });
});

describe("hide and hideHost", () => {
  it("replaces the URL as parsed and as given", () => {
    expect(hide("failed https://J.example/a b", "https://J.example/a b", "<U>")).toBe("failed <U>");
    expect(hide("failed https://j.example/", "https://J.example/", "<U>")).toBe("failed <U>");
  });
  it("replaces whole host names only, ignoring case", () => {
    expect(hideHost("getaddrinfo ENOTFOUND Jev.Example and jev-latest and api.jev.example", "https://jev.example/x")).toBe("getaddrinfo ENOTFOUND <host> and jev-latest and api.jev.example");
    expect(hideHost("at 110.0.0.5 and 10.0.0.5", "http://10.0.0.5/x")).toBe("at 110.0.0.5 and <host>");
  });
  it("keeps the text when the URL does not parse", () => {
    expect(hideHost("text", "not a url")).toBe("text");
  });
});

describe("detail", () => {
  const same = (s: string) => s;
  it("reads detail, then error.message", () => {
    expect(detail(JSON.stringify({ detail: "d" }), same, false)).toBe("d");
    expect(detail(JSON.stringify({ error: { message: "m" } }), same, false)).toBe("m");
    expect(detail(JSON.stringify({ other: 1 }), same, false)).toBeUndefined();
    expect(detail("<html>", same, false)).toBeUndefined();
  });
  it("redacts every string and key and makes JSON text of a non-string reason", () => {
    const red = (s: string) => s.replaceAll("SECRET", "<K>");
    expect(detail(JSON.stringify({ detail: { SECRET: "has SECRET inside", n: 1 } }), red, false)).toBe("{\"<K>\":\"has SECRET inside\",\"n\":1}".replace("has SECRET inside", "has <K> inside"));
  });
  it("redacts a numeric key echoed as a JSON number, only when asked to", () => {
    const red = (s: string) => s.replaceAll("12345678", "<K>");
    expect(detail("{\"detail\":{\"v\":12345678}}", red, true)).toBe("{\"v\":\"<K>\"}");
    expect(detail("{\"detail\":{\"v\":12345678}}", red, false)).toBe("{\"v\":12345678}");
  });
});

describe("contextRefusal", () => {
  const body = (e: Record<string, unknown>) => JSON.stringify({ error: { type: "exceed_context_size_error", ...e } });
  it("reads the exact numbers of a context refusal", () => {
    expect(contextRefusal(body({ n_prompt_tokens: 40025, n_ctx: 32768 }))).toEqual({ tokens: 40025, nctx: 32768 });
  });
  it("accepts only whole numbers with tokens >= nctx >= 2 and the right type", () => {
    expect(contextRefusal(body({ n_prompt_tokens: 32768, n_ctx: 32768 }))).toEqual({ tokens: 32768, nctx: 32768 });
    expect(contextRefusal(body({ n_prompt_tokens: 32767, n_ctx: 32768 }))).toBeUndefined();
    expect(contextRefusal(body({ n_prompt_tokens: 5, n_ctx: 1 }))).toBeUndefined();
    expect(contextRefusal(body({ n_prompt_tokens: 40025.5, n_ctx: 32768 }))).toBeUndefined();
    expect(contextRefusal(body({ n_prompt_tokens: "40025", n_ctx: 32768 }))).toBeUndefined();
    expect(contextRefusal(JSON.stringify({ error: { type: "other", n_prompt_tokens: 40025, n_ctx: 32768 } }))).toBeUndefined();
    expect(contextRefusal("not json")).toBeUndefined();
  });
});

describe("sendRequest", () => {
  const env = { jevUrl: "https://jev.example/v1/x?token=abc", key: KEY };

  it("sends the POST with model, state and questions, and returns a 2xx text unchanged", async () => {
    const f = fake({ status: 200, text: "{\"answers\":{}}" });
    const out = await sendRequest({ ...env, jevUrl: undefined, base: "https://api.example" }, STATE, QUESTIONS, f.doFetch);
    expect(out).toEqual({ kind: "ok", status: 200, text: "{\"answers\":{}}" });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].url).toBe("https://api.example/v1/systemone");
    expect(f.calls[0].init.method).toBe("POST");
    expect(f.calls[0].init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(f.calls[0].init.body)).toEqual({ model: "jev-latest", state: STATE, questions: QUESTIONS });
  });
  it("sends the configured model", async () => {
    const f = fake({ status: 200, text: "{}" });
    await sendRequest({ ...env, model: "jev-x" }, STATE, QUESTIONS, f.doFetch);
    expect((JSON.parse(f.calls[0].init.body) as { model: string }).model).toBe("jev-x");
  });
  it("sends the bearer key only to an https endpoint", async () => {
    const https = fake({ status: 200, text: "{}" });
    await sendRequest(env, STATE, QUESTIONS, https.doFetch);
    expect(https.calls[0].init.headers["Authorization"]).toBe(`Bearer ${KEY}`);
    const http = fake({ status: 200, text: "{}" });
    await sendRequest({ jevUrl: "http://127.0.0.1:1/x", key: KEY }, STATE, QUESTIONS, http.doFetch);
    expect(http.calls[0].init.headers["Authorization"]).toBeUndefined();
    const none = fake({ status: 200, text: "{}" });
    await sendRequest({ jevUrl: "https://jev.example/x" }, STATE, QUESTIONS, none.doFetch);
    expect(none.calls[0].init.headers["Authorization"]).toBeUndefined();
  });
  it("treats every 2xx as ok and everything else as http", async () => {
    expect((await sendRequest(env, STATE, QUESTIONS, fake({ status: 299, text: "x" }).doFetch)).kind).toBe("ok");
    expect((await sendRequest(env, STATE, QUESTIONS, fake({ status: 300, text: "x" }).doFetch)).kind).toBe("http");
    expect((await sendRequest(env, STATE, QUESTIONS, fake({ status: 199, text: "x" }).doFetch)).kind).toBe("http");
  });
  it("gives the redacted reason of an HTTP error and none when the body has none", async () => {
    const out = await sendRequest(env, STATE, QUESTIONS, fake({ status: 500, text: JSON.stringify({ error: { message: `boom ${KEY} at https://jev.example/v1/x?token=abc` } }) }).doFetch);
    expect(out).toEqual({ kind: "http", status: 500, reason: "boom <TYPESAFE_API_KEY> at <JEV_URL>" });
    expect(await sendRequest(env, STATE, QUESTIONS, fake({ status: 502, text: "<html>" }).doFetch)).toEqual({ kind: "http", status: 502 });
  });
  it("cuts a reason after 1000 characters, never inside a surrogate pair", async () => {
    const long = await sendRequest(env, STATE, QUESTIONS, fake({ status: 500, text: JSON.stringify({ detail: "x".repeat(1500) }) }).doFetch);
    expect(long).toMatchObject({ kind: "http" });
    expect((long as { reason: string }).reason).toBe("x".repeat(1000) + "…");
    const pair = await sendRequest(env, STATE, QUESTIONS, fake({ status: 500, text: JSON.stringify({ detail: "a".repeat(999) + "\u{1F600}" + "b".repeat(50) }) }).doFetch);
    expect((pair as { reason: string }).reason).toBe("a".repeat(999) + "…");
    const exact = await sendRequest(env, STATE, QUESTIONS, fake({ status: 500, text: JSON.stringify({ detail: "y".repeat(1000) }) }).doFetch);
    expect((exact as { reason: string }).reason).toBe("y".repeat(1000));
  });
  it("reads a context refusal of a 400 into refusal, next to the reason", async () => {
    const text = JSON.stringify({ error: { code: 400, type: "exceed_context_size_error", message: "too big", n_prompt_tokens: 40025, n_ctx: 32768 } });
    expect(await sendRequest(env, STATE, QUESTIONS, fake({ status: 400, text }).doFetch)).toEqual({ kind: "http", status: 400, reason: "too big", refusal: { tokens: 40025, nctx: 32768 } });
    expect(await sendRequest(env, STATE, QUESTIONS, fake({ status: 500, text }).doFetch)).not.toHaveProperty("refusal");
  });
  it("maps a TimeoutError and an AbortError to timeout and aborted with their message", async () => {
    expect(await sendRequest(env, STATE, QUESTIONS, fake(named("TimeoutError", "timeout after 4000ms")).doFetch)).toEqual({ kind: "error", code: "timeout", message: "timeout after 4000ms" });
    expect(await sendRequest(env, STATE, QUESTIONS, fake(named("AbortError", "the call was abandoned")).doFetch)).toEqual({ kind: "error", code: "aborted", message: "the call was abandoned" });
  });
  it("redacts the URL, the host and a key of 6 or more characters in a network error", async () => {
    const e = new Error(`fetch failed https://jev.example/v1/x?token=abc key ${KEY} host jev.example`);
    expect(await sendRequest(env, STATE, QUESTIONS, fake(e).doFetch)).toEqual({ kind: "error", code: "network", message: "fetch failed <JEV_URL> key <TYPESAFE_API_KEY> host <host>" });
    const viaBase = await sendRequest({ base: "https://api.example", key: KEY }, STATE, QUESTIONS, fake(new Error("failed https://api.example/v1/systemone")).doFetch);
    expect(viaBase).toEqual({ kind: "error", code: "network", message: "failed <TYPESAFE_BASE_URL>/v1/systemone" });
  });
  it("leaves a key shorter than 6 characters alone and shows the default endpoint", async () => {
    const out = await sendRequest({ key: "abc" }, STATE, QUESTIONS, fake(new Error("abc failed https://api.typesafe.ai/v1/systemone")).doFetch);
    expect(out).toEqual({ kind: "error", code: "network", message: "abc failed https://api.typesafe.ai/v1/systemone" });
  });
  it("answers an invalid configuration as config without calling doFetch", async () => {
    const f = fake({ status: 200, text: "{}" });
    expect(await sendRequest({ jevUrl: "ftp://x" }, STATE, QUESTIONS, f.doFetch)).toEqual({ kind: "error", code: "config", message: "JEV_URL must be an http(s) URL" });
    expect(await sendRequest({ base: "https://b.example/?q" }, STATE, QUESTIONS, f.doFetch)).toMatchObject({ kind: "error", code: "config" });
    expect(f.calls).toHaveLength(0);
  });
});
