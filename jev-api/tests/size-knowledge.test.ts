// Unit tests for loadKnowledge of jev-api (the stored density read), run against src/hooks/size.ts with a fake `$`.
import { describe, expect, it } from "vitest";
import { loadKnowledge } from "../src/hooks/size.ts";

type Knowledge = Parameters<typeof loadKnowledge>[1];

/** A fresh knowledge record; the store is read once per record. */
const fresh = (): Knowledge => ({ density: 3, persisted: Number.NaN, samples: 0, nctx: 32768, loaded: undefined });

/** A fake `$` whose first store.get fails as `mode` says (a sync throw or an async rejection), later reads answer `stored`. */
function fakeEngine(mode: "throw" | "reject", stored: unknown) {
  const gets: string[] = [];
  let first = true;
  const $ = {
    store: {
      get(key: string): Promise<unknown> {
        gets.push(key);
        if (first) {
          first = false;
          if (mode === "throw") throw new Error("store exploded");
          return Promise.reject(new Error("store exploded"));
        }
        return Promise.resolve(stored);
      },
    },
    clock: { after: () => ({ cancel: () => undefined }) },
  };
  return { $: $ as unknown as Parameters<typeof loadKnowledge>[0], gets };
}

describe("loadKnowledge", () => {
  it("a store read that throws synchronously is read again by the next call", async () => {
    const { $, gets } = fakeEngine("throw", { v: 2, n: 10 });
    const k = fresh();
    await loadKnowledge($, k);
    expect(Number.isNaN(k.persisted)).toBe(true);
    await loadKnowledge($, k);
    expect(gets).toEqual(["density", "density"]);
    expect(k.persisted).toBe(2);
    expect(k.samples).toBe(10);
  });

  it("an async store rejection is read again by the next call", async () => {
    const { $, gets } = fakeEngine("reject", { v: 2, n: 10 });
    const k = fresh();
    await loadKnowledge($, k);
    await loadKnowledge($, k);
    expect(gets).toEqual(["density", "density"]);
    expect(k.persisted).toBe(2);
  });
});
