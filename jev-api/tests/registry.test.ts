// Unit tests of jev-api's tool registration (src/hooks/registry.ts) with a fake `$`: names, retry back-off, bounded waits.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureTools, MAX_RETRY_MS, registerOne, RETRY_BASE_MS } from "../src/hooks/registry.ts";

type Engine = Parameters<typeof registerOne>[0];
type RegState = Parameters<typeof registerOne>[1];

const T0 = Date.UTC(2026, 10, 20, 12);
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

/** The registration state of a fresh module instance. */
const fresh = (): RegState => ({ names: new Set<string>(), registered: false, pending: undefined, gen: 0, retryAt: 0, failures: 0, stuck: false });

/** A fake `$`: `register` answers each `$.tool.register`, log lines and `$.clock.after` timers are recorded. */
function fake(register: () => Promise<unknown>) {
  const logs: string[] = [];
  const timers: { ms: number; fn: () => unknown; cancelled: boolean }[] = [];
  let registrations = 0;
  const $ = {
    tool: { register: () => (registrations++, register()) },
    ui: { log: (text: string) => void logs.push(text) },
    clock: {
      after(ms: number, fn: () => unknown) {
        const timer = { ms, fn, cancelled: false };
        timers.push(timer);
        return { cancel: () => void (timer.cancelled = true) };
      },
    },
  } as unknown as Engine;
  return { $, logs, timers, registrations: () => registrations };
}

describe("registerOne", () => {
  it("records the engine's name only when it is an mcp name of this tool", async () => {
    for (const [tool, added] of [["mcp__jev-api__request", true], ["mcp__other__noul", false], ["request", false]] as const) {
      const st = fresh();
      await registerOne(fake(async () => ({ tool })).$, st);
      expect(st.registered).toBe(true);
      expect(st.names.has(tool)).toBe(added);
    }
  });

  it("counts a refusal, logs the first one only and backs off: at once, then the base delay doubling up to the cap", async () => {
    const f = fake(() => Promise.reject(new Error("session not bound")));
    const st = fresh();
    for (let n = 1; n <= 20; n++) {
      await registerOne(f.$, st);
      expect(st.failures).toBe(n);
      expect(st.retryAt - T0).toBe(n === 1 ? 0 : Math.min(MAX_RETRY_MS, RETRY_BASE_MS * 2 ** (n - 2)));
    }
    expect(st.registered).toBe(false);
    expect(st.retryAt - T0).toBe(MAX_RETRY_MS);
    expect(f.logs).toEqual(["registering request failed: session not bound"]);
  });

  it("does not record the failure of an attempt begun under an older generation", async () => {
    let reject: (err: Error) => void = () => {};
    const f = fake(() => new Promise((_resolve, rej) => (reject = rej)));
    const st = fresh();
    const attempt = registerOne(f.$, st);
    st.gen++;
    reject(new Error("late refusal"));
    await attempt;
    expect(st.failures).toBe(0);
    expect(st.retryAt).toBe(0);
    expect(f.logs).toEqual([]);
  });
});

describe("ensureTools", () => {
  it("registers a missing tool, waits for it and cancels its wait timer", async () => {
    const f = fake(async () => ({ tool: "mcp__jev-api__request" }));
    const st = fresh();
    await ensureTools(f.$, st, 1000);
    expect(st.registered).toBe(true);
    expect(st.pending).toBeUndefined();
    expect(f.timers.map((t) => [t.ms, t.cancelled])).toEqual([[1000, true]]);
    await ensureTools(f.$, st, 1000);
    expect(f.registrations()).toBe(1);
  });

  it("does not try again before the retry time and tries at it", async () => {
    const f = fake(() => Promise.reject(new Error("refused")));
    const st = { ...fresh(), failures: 1, retryAt: T0 + RETRY_BASE_MS };
    await ensureTools(f.$, st, 1000);
    expect(f.registrations()).toBe(0);
    vi.setSystemTime(T0 + RETRY_BASE_MS);
    await ensureTools(f.$, st, 1000);
    expect(f.registrations()).toBe(1);
  });

  it("tries at once when the retry time lies further ahead than any back-off (the wall clock stepped back)", async () => {
    const f = fake(async () => ({ tool: "mcp__jev-api__request" }));
    const st = { ...fresh(), failures: 3, retryAt: T0 + MAX_RETRY_MS + 1 };
    await ensureTools(f.$, st, 1000);
    expect(f.registrations()).toBe(1);
    expect(st.registered).toBe(true);
  });

  it("waits for a hanging registration once, marks it stuck and does not wait for it again", async () => {
    const f = fake(() => new Promise(() => {}));
    const st = fresh();
    const first = ensureTools(f.$, st, 1000);
    while (f.timers.length === 0) await Promise.resolve();
    f.timers[0]?.fn();
    await first;
    expect(st.stuck).toBe(true);
    await ensureTools(f.$, st, 1000);
    expect(f.registrations()).toBe(1);
    expect(f.timers).toHaveLength(1);
  });
});
