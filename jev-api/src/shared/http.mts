/**
 * The HTTP core of jev-api: endpoint resolution, redaction of what reaches the model, the reason of an HTTP error and
 * the System One request itself (`sendRequest`). The MCP server (`mcp/server.mts`) and the hooks' fallback transport
 * both call it, each with its own `doFetch`.
 *
 * @remarks
 * Pure: no `node:` import, no engine access, no module state, so a function-hooks module can import it from outside
 * `hooks/` (checked live: a hooks module may import `../shared/x.mjs`). It keeps two small guards of its own, because
 * it cannot import the hooks' helpers.
 *
 * @packageDocumentation
 */

/** The System One endpoint used when neither JEV_URL nor TYPESAFE_BASE_URL is set. */
export const DEFAULT_JEV_URL = "https://api.typesafe.ai/v1/systemone";

/** The model sent when TYPESAFE_DEFAULT_MODEL is unset or blank. */
export const DEFAULT_MODEL = "jev-latest";

/** An http(s) URL: the `JEV_URL` check. */
export const HTTP_URL = /^https?:\/\/[^/?#\s]+(?:[/?#]\S*)?$/i;

/** An http(s) API root: like {@link HTTP_URL} but without query or fragment, since a path gets appended. */
export const HTTP_BASE = /^https?:\/\/[^/?#\s]+(?:\/[^?#\s]*)?$/i;

/** The most characters of an API error reason passed on to the model (a server may send megabytes; cut after the redaction, never before it). */
export const MAX_DETAIL = 1000;

/** The shortest API key that is replaced in error texts (a shorter one would match ordinary words). */
export const MIN_REDACT_KEY = 6;

/** The `error.type` System One answers a prompt over its context window with (HTTP 400). */
export const CONTEXT_ERROR = "exceed_context_size_error";

/** The env values of a request, trimmed; undefined when unset or blank. */
export type HttpEnv = {
  /** TYPESAFE_API_KEY. */
  key?: string | undefined;
  /** TYPESAFE_BASE_URL. */
  base?: string | undefined;
  /** JEV_URL. */
  jevUrl?: string | undefined;
  /** TYPESAFE_DEFAULT_MODEL. */
  model?: string | undefined;
};

/** What one System One request came to. */
export type Outcome =
  | {
    /** A 2xx answer. */
    kind: "ok";
    /** The HTTP status. */
    status: number;
    /** The response body, unchanged. */
    text: string;
  }
  | {
    /** Any other status. */
    kind: "http";
    /** The HTTP status. */
    status: number;
    /** The API's reason (its `detail` or `error.message`), redacted and cut after {@link MAX_DETAIL} characters. */
    reason?: string;
    /** For a 400 `exceed_context_size_error`: the exact tokens of the refused prompt and the server's context window. */
    refusal?: { tokens: number; nctx: number };
  }
  | {
    /** No answer: the request failed before there was one. */
    kind: "error";
    /** `timeout` and `aborted` come from the caller's `doFetch`; `config` is an invalid endpoint variable; `network` is anything else. */
    code: "timeout" | "aborted" | "network" | "config";
    /** The redacted text for the model. */
    message: string;
  };

/** The HTTP call of the caller: resolves status and body text, throws on failure (an `Error` named `TimeoutError` or `AbortError` for the two ends the caller sets). */
export type DoFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ status: number; text: string }>;

/**
 * Whether a value is a plain object (not an array, not null).
 *
 * @param v - The value to test.
 * @returns True for a plain object.
 */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Parses JSON without throwing.
 *
 * @param text - The raw text.
 * @param reviver - Optional `JSON.parse` reviver; its third argument carries a primitive's source text where the engine supports it.
 * @returns The parsed value, or undefined when the text is not JSON (valid JSON never parses to undefined).
 */
function json(text: string, reviver?: (key: string, value: unknown, context?: { source?: string }) => unknown): unknown {
  try {
    return JSON.parse(text, reviver) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * The message of a thrown value.
 *
 * @param err - What was thrown or rejected.
 * @returns Its message, or the value as text.
 */
function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch {
    return "unknown error"; // a null-prototype object, or one whose toString throws
  }
}

/**
 * Replaces a URL in an error text, as the URL parser spells it and as given, with a placeholder.
 *
 * @param text - The error text.
 * @param url - The URL to hide.
 * @param placeholder - What stands in its place.
 * @returns The text without the URL.
 */
export function hide(text: string, url: string, placeholder: string): string {
  let href = url;
  try {
    href = new URL(url).href;
  } catch {
    // The engine quotes a URL it cannot parse as given.
  }
  return text.replaceAll(href, placeholder).replaceAll(url, placeholder);
}

/**
 * Replaces the bare host of a URL in an error text. A DNS failure quotes only the host (`getaddrinfo ENOTFOUND <host>`,
 * live on 2.1.325), which may be private too. Only whole host names are replaced, ignoring case: the host `jev` must
 * not turn `jev-latest` or `api.jev`, nor the host `10.0.0.5` turn `110.0.0.5`, into something else.
 *
 * @param text - The text.
 * @param url - The endpoint URL; one that does not parse changes nothing.
 * @returns The text with the host as `<host>`.
 */
export function hideHost(text: string, url: string): string {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    return text;
  }
  if (!host) return text;
  // An IPv6 host comes with brackets, an error text quotes the bare address.
  let t = text;
  for (const h of new Set([host, host.replace(/^\[(.*)\]$/, "$1")])) {
    t = t.replace(new RegExp(`(?<![\\w.-])${h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "gi"), "<host>");
  }
  return t;
}

/**
 * Resolves the System One endpoint: JEV_URL, else TYPESAFE_BASE_URL plus `/v1/systemone`, else the default.
 *
 * @param jev - The trimmed JEV_URL value (full route), undefined when unset or blank.
 * @param base - The trimmed TYPESAFE_BASE_URL value (API root), undefined when unset or blank.
 * @returns The URL, or the error naming the invalid variable (an invalid set value never falls back).
 */
export function endpoint(jev: string | undefined, base: string | undefined): { ok: true; url: string } | { ok: false; error: string } {
  if (jev) return HTTP_URL.test(jev) ? { ok: true, url: jev } : { ok: false, error: "JEV_URL must be an http(s) URL" };
  if (base) {
    return HTTP_BASE.test(base) ? { ok: true, url: base.replace(/\/+$/, "") + "/v1/systemone" } : { ok: false, error: "TYPESAFE_BASE_URL must be an http(s) URL without query or fragment" };
  }
  return { ok: true, url: DEFAULT_JEV_URL };
}

/**
 * Extracts the API's reason from an error body: its `detail`, else the `message` of its `error` object.
 *
 * @param text - The raw response body.
 * @param redact - Replaces what must not reach the model; applied to every string and object key of the reason before a non-string one is made into JSON text.
 * @param numbers - Whether a number can carry a secret (the key is made of number characters): only then is every number of the body redacted, which costs seconds on an error body of megabytes of numbers.
 * @returns The reason redacted (a string as is, anything else JSON-stringified), or undefined when there is none.
 */
export function detail(text: string, redact: (s: string) => string, numbers: boolean): string | undefined {
  // A number is matched on its source text: parsing rounds 20 digits to 17 and drops `.0` and `e0`, so a numeric key would no longer match.
  const body = json(text, numbers ? (_k, v, c) => (typeof v === "number" && c?.source !== undefined && redact(c.source) !== c.source ? c.source : v) : undefined);
  if (!isRecord(body)) return undefined;
  const error = body["error"];
  const why = body["detail"] ?? (isRecord(error) ? error["message"] : undefined);
  if (why === undefined) return undefined;
  // Redacted per string, number (a numeric key echoed as a JSON number) and object key before the JSON text is made: JSON escapes quotes and backslashes, a secret containing one would no longer match.
  /** The JSON.stringify replacer: redacts strings, numbers and object keys; other values pass. */
  const clean = (v: unknown): unknown => {
    if (typeof v === "string") return redact(v);
    if (typeof v === "number") return numbers && redact(String(v)) !== String(v) ? redact(String(v)) : v;
    return isRecord(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [redact(k), x])) : v;
  };
  return typeof why === "string" ? redact(why) : JSON.stringify(why, (_k, v: unknown) => clean(v));
}

/**
 * Reads System One's refusal of a prompt over its context window: HTTP 400, `error.type` `exceed_context_size_error`,
 * with the exact token count of the prompt and the context size as whole numbers.
 *
 * @param text - The raw response body.
 * @returns The refused prompt's tokens and the server's context window, or undefined for any other body.
 */
export function contextRefusal(text: string): { tokens: number; nctx: number } | undefined {
  const body = json(text);
  const error = isRecord(body) ? body["error"] : undefined;
  if (!isRecord(error) || error["type"] !== CONTEXT_ERROR) return undefined;
  const tokens = error["n_prompt_tokens"];
  const nctx = error["n_ctx"];
  if (typeof tokens !== "number" || typeof nctx !== "number" || !Number.isInteger(tokens) || !Number.isInteger(nctx) || nctx < 2 || tokens < nctx) return undefined;
  return { tokens, nctx };
}

/**
 * Sends the questions of one call in one System One request and says what came of it.
 *
 * @param env - The env values, trimmed.
 * @param state - The text the questions are about.
 * @param questionsObject - The `questions` of the request body, keyed as the answers come back.
 * @param doFetch - The caller's HTTP call; it sets timeout and cancellation and throws a `TimeoutError` or `AbortError` for those.
 * @returns The outcome; never rejects. Every text in it that may carry the endpoint or the key is redacted.
 */
export async function sendRequest(env: HttpEnv, state: string, questionsObject: Record<string, unknown>, doFetch: DoFetch): Promise<Outcome> {
  const target = endpoint(env.jevUrl, env.base);
  if (!target.ok) return { kind: "error", code: "config", message: target.error };
  const { key } = env;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  // The key never travels in cleartext: over plain http the request goes out without it.
  if (key && /^https:/i.test(target.url)) headers["Authorization"] = `Bearer ${key}`;
  // Text that reaches the model (a fetch error, an error body a server may echo the request into) must not carry the endpoint
  // or the key: a runtime quotes a header value it rejects (a newline or a non-Latin1 character in the key), whole.
  const redact = (text: string): string => {
    // In this order: the URL first (it may contain the key), the key before the host (a key may contain the host text).
    let t = env.jevUrl ? hide(text, target.url, "<JEV_URL>") : env.base ? hide(text, target.url, "<TYPESAFE_BASE_URL>/v1/systemone") : text;
    if (key && key.length >= MIN_REDACT_KEY) t = t.replaceAll(key, "<TYPESAFE_API_KEY>"); // not a short key: it would match ordinary words
    return env.jevUrl || env.base ? hideHost(t, target.url) : t;
  };
  try {
    const res = await doFetch(target.url, { method: "POST", headers, body: JSON.stringify({ model: env.model ?? DEFAULT_MODEL, state, questions: questionsObject }) });
    if (res.status >= 200 && res.status < 300) return { kind: "ok", status: res.status, text: res.text };
    const refusal = res.status === 400 ? contextRefusal(res.text) : undefined;
    // Only a key made of number characters can sit inside a JSON number's text.
    const why = detail(res.text, redact, key !== undefined && key.length >= MIN_REDACT_KEY && /^[-+.\deE]+$/.test(key));
    let reason = why === undefined ? "" : why.trim(); // detail() already redacted it: a second pass would nest the host placeholder
    if (reason.length > MAX_DETAIL) {
      reason = reason.slice(0, MAX_DETAIL);
      if (/[\uD800-\uDBFF]$/.test(reason)) reason = reason.slice(0, -1); // not a lone high surrogate
      reason += "…";
    }
    return { kind: "http", status: res.status, ...(reason === "" ? {} : { reason }), ...(refusal ? { refusal } : {}) };
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    // The caller's own texts (`timeout after <ms>ms`, `the call was abandoned`) carry no URL; any other error quotes it.
    const code = name === "TimeoutError" ? "timeout" : name === "AbortError" ? "aborted" : "network";
    return { kind: "error", code, message: redact(messageOf(err)) };
  }
}
