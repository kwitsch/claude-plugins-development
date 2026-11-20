// Unit tests of jev-api's size logic (src/hooks/size.ts): the learned density, the latency budget, the state cut and the refusal texts.
// loadKnowledge is covered by size-knowledge.test.ts.
import { describe, expect, it } from "vitest";
import { aimHundreds, CUT_MARGIN_TOKENS, cutState, estimateTokens, isTooBig, LATENCY_LINEAR_MS, LATENCY_MARGIN, LATENCY_QUADRATIC_MS, learn, MAX_DENSITY, MIN_BUDGET_TOKENS, MIN_DENSITY, MIN_SAMPLE_TOKENS, preflightError, PROMPT_OVERHEAD_TOKENS, refusedDensity, stateForBudget, timeBudgetTokens, tooBigError } from "../src/hooks/size.ts";

type Engine = Parameters<typeof learn>[0];
type Knowledge = Parameters<typeof learn>[1];

/** A knowledge record at density 3 whose stored value is also 3. */
const fresh = (): Knowledge => ({ density: 3, persisted: 3, samples: 0, nctx: 32768, loaded: undefined });

/** A fake `$` that records every store write; `broken` makes the write throw synchronously. */
function fakeStore(broken = false) {
  const sets: [string, unknown][] = [];
  const $ = {
    store: {
      set(key: string, value: unknown): Promise<unknown> {
        if (broken) throw new Error("store exploded");
        sets.push([key, value]);
        return Promise.resolve();
      },
    },
  } as unknown as Engine;
  return { $, sets };
}

/** The characters of a prompt that measures `density` characters per token at `tokens` tokens. */
const charsAt = (density: number, tokens: number): number => density * (tokens - PROMPT_OVERHEAD_TOKENS);

describe("isTooBig", () => {
  it("tells the server's context refusal from a tool result", () => {
    expect(isTooBig({ tooBig: { tokens: 40000, limit: 32767, chars: 1, questionsChars: 1 } })).toBe(true);
    expect(isTooBig({ result: "[]" })).toBe(false);
    expect(isTooBig({ deny: "request: x", tooBig: "no object" })).toBe(false);
  });
});

describe("learn", () => {
  it("ignores a prompt below the sample size and a token count that is not a number", () => {
    const { $, sets } = fakeStore();
    const k = fresh();
    learn($, k, 100_000, MIN_SAMPLE_TOKENS - 1);
    learn($, k, 100_000, "1000");
    learn($, k, 100_000, Number.NaN);
    expect(k).toEqual(fresh());
    expect(sets).toEqual([]);
  });

  it("folds a sample at the sample size into the density with the newest sample weighted 0.2", () => {
    const { $ } = fakeStore();
    const k = fresh();
    learn($, k, charsAt(4, MIN_SAMPLE_TOKENS), MIN_SAMPLE_TOKENS);
    expect(k.density).toBeCloseTo(3.2, 10);
    expect(k.samples).toBe(1);
  });

  it("clamps a sample above the highest density", () => {
    const { $ } = fakeStore();
    const k = fresh();
    learn($, k, charsAt(100, 1000), 1000);
    expect(k.density).toBeCloseTo(0.8 * 3 + 0.2 * MAX_DENSITY, 10);
  });

  it("clamps a sample below the lowest density", () => {
    const { $ } = fakeStore();
    const k = fresh();
    learn($, k, 0, 1000);
    expect(k.density).toBeCloseTo(0.8 * 3 + 0.2 * MIN_DENSITY, 10);
  });

  it("writes the density to the store only once it moved more than a tenth from the stored value", () => {
    const { $, sets } = fakeStore();
    const k = fresh();
    learn($, k, charsAt(4, 1000), 1000); // 3.2: 6.7 % from 3
    expect(sets).toEqual([]);
    expect(k.persisted).toBe(3);
    learn($, k, charsAt(4, 1000), 1000); // 3.36: 12 % from 3
    expect(sets).toHaveLength(1);
    const [key, value] = sets[0] ?? [];
    expect(key).toBe("density");
    expect((value as { v: number; n: number }).v).toBeCloseTo(3.36, 10);
    expect((value as { v: number; n: number }).n).toBe(2);
    expect(k.persisted).toBe(k.density);
  });

  it("never writes while the stored value is unknown, but still learns", () => {
    const { $, sets } = fakeStore();
    const k = { ...fresh(), persisted: Number.NaN };
    learn($, k, charsAt(100, 1000), 1000);
    expect(sets).toEqual([]);
    expect(k.density).toBeCloseTo(4, 10);
  });

  it("survives a store whose write throws", () => {
    const { $ } = fakeStore(true);
    const k = fresh();
    expect(() => learn($, k, charsAt(100, 1000), 1000)).not.toThrow();
    expect(k.samples).toBe(1);
  });
});

describe("timeBudgetTokens", () => {
  /** The latency model's time for `t` tokens in ms, with the margin. */
  const latency = (t: number): number => (LATENCY_LINEAR_MS * t + LATENCY_QUADRATIC_MS * t * t) * LATENCY_MARGIN;

  it("is the largest token count whose modelled latency fits the timeout", () => {
    for (const timeoutMs of [5000, 20_000, 30_000]) {
      const t = timeBudgetTokens(timeoutMs);
      expect(latency(t)).toBeLessThanOrEqual(timeoutMs);
      expect(latency(t + 1)).toBeGreaterThan(timeoutMs);
    }
  });

  it("never shrinks below the floor", () => {
    expect(timeBudgetTokens(1)).toBe(MIN_BUDGET_TOKENS);
    expect(latency(MIN_BUDGET_TOKENS)).toBeGreaterThan(1);
  });
});

describe("estimates and cuts", () => {
  it("estimateTokens rounds the characters up to whole tokens and adds the fixed overhead", () => {
    expect(estimateTokens(10, 3)).toBe(4 + PROMPT_OVERHEAD_TOKENS);
    expect(estimateTokens(9, 3)).toBe(3 + PROMPT_OVERHEAD_TOKENS);
    expect(estimateTokens(0, 3)).toBe(PROMPT_OVERHEAD_TOKENS);
  });

  it("cutState returns a state that fits unchanged", () => {
    expect(cutState("abc", 3)).toBe("abc");
    expect(cutState("", 0)).toBe("");
  });

  it("cutState keeps six tenths from the start and the rest from the end, naming what it dropped", () => {
    expect(cutState("a".repeat(60) + "b".repeat(40), 10)).toBe("aaaaaa\n[... 90 characters omitted ...]\nbbbb");
  });

  it("cutState never leaves half a surrogate pair at either cut", () => {
    const state = "😀".repeat(10); // 20 UTF-16 units
    expect(cutState(state, 5)).toBe("😀\n[... 16 characters omitted ...]\n😀"); // head 3 units -> 2, tail 2
    expect(cutState(state, 3)).toBe("😀\n[... 18 characters omitted ...]\n"); // tail 1 unit (a low surrogate) -> dropped
  });

  it("stateForBudget keeps the overhead and the margin free and never goes below zero", () => {
    expect(stateForBudget(1000 + PROMPT_OVERHEAD_TOKENS + CUT_MARGIN_TOKENS, 3, 100)).toBe(2900);
    expect(stateForBudget(1000 + PROMPT_OVERHEAD_TOKENS + CUT_MARGIN_TOKENS, 2.5, 0)).toBe(2500);
    expect(stateForBudget(50, 3, 0)).toBe(0);
    expect(stateForBudget(2000, 3, 1_000_000)).toBe(0);
  });

  it("refusedDensity is the refused prompt's characters over its tokens less the overhead, and aimHundreds rounds down", () => {
    expect(refusedDensity({ tokens: 1000 + PROMPT_OVERHEAD_TOKENS, limit: 500, chars: 3000, questionsChars: 0 })).toBe(3);
    expect(aimHundreds(2999)).toBe(2900);
    expect(aimHundreds(99)).toBe(0);
  });
});

describe("refusal texts", () => {
  const refused = { tokens: 40_000 + PROMPT_OVERHEAD_TOKENS, limit: 32_767, chars: 120_000, questionsChars: 100 };

  it("tooBigError names the exact numbers and aims at the smaller of the refused limit and the timeout's budget", () => {
    expect(tooBigError(refused, 50_000)).toEqual({ deny: "request: state too large for System One: the request has 40026 tokens, the limit is 32767; shorten the state to about 97900 characters" });
    expect(tooBigError(refused, 10_000 + PROMPT_OVERHEAD_TOKENS + CUT_MARGIN_TOKENS)).toEqual({ deny: "request: state too large for System One: the request has 40026 tokens, the limit is 32767; shorten the state to about 29900 characters" });
  });

  it("preflightError names the server's limit, the timeout with a size, or only the timeout at the floor", () => {
    expect(preflightError(40_000, 32_767, 32_767, 20_000, 12_345)).toEqual({ deny: "request: state too large for System One: at least 40000 tokens, the limit is 32767; shorten the state to about 12300 characters" });
    expect(preflightError(9000, 5000, 32_767, 5000, 14_999)).toEqual({ deny: "request: state too large for the timeout of 5 s: at least 9000 tokens, about 5000 fit; shorten the state to about 14900 characters or raise the timeout (at most 30 s)" });
    expect(preflightError(5000, MIN_BUDGET_TOKENS, 32_767, 500, 0)).toEqual({ deny: "request: state too large for the timeout of 0.5 s: at least 5000 tokens; raise the timeout (at most 30 s)" });
  });
});
