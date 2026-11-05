// A vitest stand-in for Claude Code's mod test kit (`claude-code/testing`, which exists only inside the `claude`
// binary and runs under `claude plugin test`). Mirrors the kit's API so a kit test ports by changing its imports.
// Semantics follow https://code.claude.com/docs/en/plugins/mods/test.md and the kit's typings; see README.md.
import { test as vitestTest } from "vitest";

/** Who fires an event: a plugin (or `engine`/`test`) and its tier. */
interface Origin {
  /** The plugin's name. */
  plugin: string;
  /** Its tier. */
  tier: string;
}

/** A hook function as a mod registers it; its arguments and result depend on the event. */
type HookFn = (...args: unknown[]) => unknown;

/** The `on` a mod's `register` gets: `on(event, fn)` or `on(event, matcher, fn)`. */
type On = (event: string, a: unknown, b?: unknown) => { catch: (handler: HookFn) => void };

/** An inline plugin of a test (`plugins` option). */
interface Plugin {
  /** The plugin's name. */
  name: string;
  /** Its tier (`user` when not given). */
  tier?: string;
  /** Registers its hooks. */
  register: (on: On, options: unknown) => void;
}

/** A drawn element: plain `{ type, props, children }` data. */
interface UiElement {
  /** The element name. */
  type: string;
  /** Its props. */
  props: Record<string, unknown>;
  /** Its children. */
  children: unknown[];
}

/** One registered hook (a plugin's or a test stub). */
interface Hook {
  /** The registering plugin (`test` for a stub). */
  plugin: string;
  /** Its tier. */
  tier: string;
  /** Load order of the plugin (Infinity for stubs). */
  idx: number;
  /** The `on` pattern. */
  event: string;
  /** Fields the event input must hold. */
  matcher?: unknown;
  /** The hook. */
  fn: HookFn;
  /** The handler set by `.catch(handler)`. */
  catcher?: HookFn;
}

/** A mounted render site. */
interface Site {
  /** The ui.render event it was mounted with. */
  e: Record<string, unknown>;
  /** The last drawn tree. */
  tree: unknown;
  /** The draw under way (resolves when it is done). */
  drawing: Promise<unknown>;
  /** false once unmounted. */
  mounted: boolean;
  /** Queues a redraw. */
  redraw: () => unknown;
}

/** What `createKit` and a test hand an engine. */
interface EngineConfig {
  /** The built hooks module. */
  module: URL;
  /** The plugin's name. */
  plugin: string;
  /** The tier it loads in (`user` when not given). */
  tier?: string;
  /** The `options` its `register(on, options)` gets. */
  options?: Record<string, unknown>;
  /** Inline plugins loaded with it. */
  plugins?: Plugin[];
  /** What stands for vitest's `test` (the kit's own tests). */
  runner?: (name: string, opts: { timeout: number }, fn: () => Promise<void>) => void;
}

const ENGINE: Origin = Object.freeze({ plugin: "engine", tier: "core" });
const TIERS = ["prepend", "user", "append", "builtin"];
const STREAMING = new Set(["turn.step", "process.spawn"]);
// Positional arguments of each mods API call, as its event's input fields ("..." spreads an options object).
const POSITIONAL = {
  "mcp.connect": ["server"],
  "mcp.call": ["server", "tool", "args"],
  "model.classify": ["text", "labels", "options"],
  "audio.speak": ["text", "..."],
  "ui.toast": ["text", "..."],
  "ui.status": ["text"],
  "ui.log": ["text"],
  "ui.notice": ["tool_use_id", "text"],
  "ui.invalidate": ["event"],
  "fs.read": ["path"],
  "fs.write": ["path", "text"],
  "fs.list": ["path"],
  "fs.exists": ["path"],
  "fs.stat": ["path"],
  "store.get": ["key"],
  "store.set": ["key", "value"],
  "store.delete": ["key"],
  "clock.sleep": ["ms"],
  "http.fetch": ["url", "init"],
  "process.run": ["argv", "init"],
  "env.get": ["name"],
  "env.set": ["name", "value"],
};
// Mods API calls: a test's own $ cannot fire them (the kit's rule); trigger them through a mod.
const OPS = new Set([...Object.keys(POSITIONAL), "ui.open", "ui.close", "ui.resolve", "ui.blit", "clock.now", "clock.after", "clock.every", "store.keys", "session.messages", "tool.register", "command.register", "model.complete", "model.fork"]);

/** Deep-freezes a copy of `v`, as the engine hands each hook its input; values structuredClone refuses stay as they are. */
const frozen = (v) => {
  let c = v;
  try {
    c = structuredClone(v);
  } catch {
    // functions inside (a Button's onPress): freeze in place
  }
  const freeze = (o) => {
    if (o && typeof o === "object" && !Object.isFrozen(o)) {
      Object.freeze(o);
      for (const k of Object.keys(o)) freeze(o[k]);
    }
    return o;
  };
  return freeze(c);
};

/** Whether `e` holds every field of `matcher` (nested objects compared field by field). */
const fits = (matcher, e) => matcher === undefined || Object.entries(matcher).every(([k, m]) => (m && typeof m === "object" ? e?.[k] && typeof e[k] === "object" && fits(m, e[k]) : e?.[k] === m));

/** Whether an `on` pattern (a name, `ns.*` or `*`) selects `event`. */
const selects = (pattern, event) => pattern === event || pattern === "*" || (pattern.endsWith(".*") && event.startsWith(pattern.slice(0, -1)));

const isAssertion = (err) => err?.name === "AssertionError" || err?.matcherResult !== undefined;
const message = (err) => (err instanceof Error ? err.message : String(err));

/** The concatenated text of an element's string children, nested elements included. */
const textOf = (n) => (n?.children ?? []).map((c) => (typeof c === "string" || typeof c === "number" ? String(c) : c && typeof c === "object" ? textOf(c) : "")).join("");

/** Every element of a tree, depth first. */
const nodes = (n, out: UiElement[] = []): UiElement[] => {
  if (Array.isArray(n)) { for (const c of n) nodes(c, out); }
  else if (n && typeof n === "object" && typeof n.type === "string") {
    out.push(n);
    nodes(n.children ?? [], out);
  }
  return out;
};

/** Whether element `n` matches a find query `{ type, text, key }`; a string `text` is a substring match. */
const matches = (n, q) =>
  (q.type === undefined || n.type === q.type) && (q.key === undefined || n.props?.key === q.key)
  && (q.text === undefined || (q.text instanceof RegExp ? q.text.test(textOf(n)) : textOf(n).includes(q.text)));

/** `$.ui.resolve(e)`: every element name is a factory turning props into plain `{ type, props, children }` data. */
const elements = new Proxy({}, {
  get: (_, type) =>
    typeof type === "string"
      ? (props: Record<string, unknown> = {}) => {
        const { children, ...rest } = props;
        return { type, props: rest, children: children === undefined ? [] : [children].flat() };
      }
      : undefined,
});

let loads = 0;

/** One test's engine: the loaded plugins, the test's stubs, mounted sites, held clock waits and what it reported. */
class Engine {
  /** module (URL), plugin (name), tier, options, plugins (inline). */
  cfg: EngineConfig;
  /** The plugins' hooks, in load order. */
  hooks: Hook[] = [];
  /** The test's stubs. */
  stubs: Hook[] = [];
  /** Whether the test called $ (no more stubs then). */
  started = false;
  /** Loads the plugins, once. */
  loading: Promise<void> | undefined = undefined;
  /** The engine report: each skipped hook and why. */
  reported: string[] = [];
  /** Failures that fail the test even when the body passes. */
  fatal: unknown[] = [];
  /** The mounted render sites. */
  mounts = new Set<Site>();
  /** Bumped on every dispatch step: settle waits until it stops moving. */
  activity = 0;
  /** Orders clock waits due at the same time. */
  seq = 0;

  /**
   * An engine for one test.
   *
   * @param cfg - module (URL), plugin (name), tier, options, plugins (inline).
   */
  constructor(cfg: EngineConfig) {
    this.cfg = cfg;
  }

  /** The test's `on`: registers a stub beneath every plugin, before the first call on `$`. */
  stubOn = (event, a, b) => {
    if (this.started) throw new Error(`on("${event}") after the test first called $`);
    const [matcher, fn] = b === undefined ? [undefined, a] : [a, b];
    this.stubs.push({ plugin: "test", tier: "core", idx: Infinity, event, matcher, fn: fn as HookFn });
    return { catch: () => undefined };
  };

  /** Loads every plugin once, at the test's first call on `$`: a fresh instance of the module under test, then inline ones. */
  load() {
    this.started = true;
    this.loading ??= (async () => {
      const { register } = await import(`${this.cfg.module.href}${this.cfg.module.search ? "&" : "?"}claude-engine-vitest=${loads++}`);
      const list: { name: string; tier: string; register: Plugin["register"]; options: unknown }[] = [
        { name: this.cfg.plugin, tier: this.cfg.tier ?? "user", register, options: this.cfg.options },
        ...(this.cfg.plugins ?? []).map((p) => ({ ...p, tier: p.tier ?? "user", options: {} })),
      ];
      list.sort((x, y) => TIERS.indexOf(x.tier) - TIERS.indexOf(y.tier));
      list.forEach((p, idx) => {
        const bare = new Set<string>();
        p.register((event, a, b) => {
          const [matcher, fn] = b === undefined ? [undefined, a] : [a, b];
          if (matcher === undefined) {
            if (bare.has(event)) throw new Error(`${p.name}: ${event} registered twice without a matcher`);
            bare.add(event);
          }
          const hook: Hook = { plugin: p.name, tier: p.tier, idx, event, matcher, fn: fn as HookFn };
          this.hooks.push(hook);
          return { catch: (handler) => void (hook.catcher = handler) };
        }, p.options ?? {});
      });
    })();
    return this.loading;
  }

  /** Records a failing hook in the engine report; an assertion failing inside one fails the test. */
  report(hook, err) {
    const where = hook.plugin === "test" ? `the test's ${hook.event} hook` : `${hook.plugin}'s ${hook.event} hook`;
    this.reported.push(`in ${where}: ${message(err)}`);
    if (isAssertion(err)) this.fatal.push(err);
  }

  /**
   * The hooks one dispatch runs, in order: the plugins' (for a mods API call only those at or above the caller, the
   * calling hook skipped, or every hook of the caller when it called from outside a hook), then the test's stubs.
   */
  chain(event, e, caller) {
    const plugins = this.hooks.filter((h) => {
      if (!selects(h.event, event) || !fits(h.matcher, e)) return false;
      if (!caller) return true;
      if (h.idx > caller.idx) return false;
      return h.plugin !== caller.plugin || (caller.hook !== undefined && caller.hook !== h && caller.active());
    });
    return [...plugins, ...this.stubs.filter((h) => selects(h.event, event) && fits(h.matcher, e))];
  }

  /** The kit's own answer beneath the stubs: `no implementation for <event>`, except for the calls the kit answers. */
  bottom(event, e) {
    if (event === "ui.invalidate") {
      for (const m of this.mounts) if (e.event === "ui.render") m.redraw();
      return { value: undefined };
    }
    if (event === "session.append") return { message: e.message, uuid: e.uuid };
    throw new Error(`no implementation for ${event}`);
  }

  /**
   * Fires `event` through its chain and resolves to the chain's result (an async generator for a streaming event).
   *
   * @param {string} event - The event name.
   * @param {unknown} input - The event's input.
   * @param {{ origin: Origin, caller?: object, signal?: AbortSignal, bottom?: (e: unknown) => unknown }} ctx - Who fires it.
   */
  dispatch(event, input, ctx) {
    const hooks = this.chain(event, input, ctx.caller);
    const signal = ctx.signal ?? new AbortController().signal;
    const bottom = ctx.bottom ?? ((e) => this.bottom(event, e));
    const nextFor = (i, called) => Object.assign((e2) => (called.value = true, step(i + 1, e2)), { origin: ctx.origin, event, signal });
    const step = STREAMING.has(event)
      ? async function*(this: Engine, i: number, e: unknown): AsyncGenerator<unknown, unknown> {
        this.activity++;
        if (i === hooks.length) return await bottom(e);
        const h = hooks[i];
        const called = { value: false };
        const { $, end } = this.api(h);
        try {
          return yield* h.fn($, frozen(e), nextFor(i, called)) as AsyncGenerator<unknown, unknown>;
        } catch (err) {
          this.report(h, err);
          if (called.value) throw err;
          return yield* step(i + 1, e);
        } finally {
          end();
        }
      }.bind(this)
      : async (i, e) => {
        this.activity++;
        if (i === hooks.length) return bottom(e);
        const h = hooks[i];
        const called = { value: false };
        let pending;
        const next = nextFor(i, called);
        const tracked = Object.assign((e2) => (pending = next(e2)), next);
        const { $, end } = this.api(h);
        try {
          return await h.fn($, frozen(e), tracked);
        } catch (err) {
          if (h.catcher) {
            try {
              return await h.catcher($, frozen(e), Object.assign(tracked, { error: { kind: "throw", message: message(err) }, called: called.value }));
            } catch {
              // the handler failed too: skip the hook as without one
            }
          }
          this.report(h, err);
          if (pending) return pending; // the rest of the chain already ran: its outcome stands
          return step(i + 1, e);
        } finally {
          end();
          this.activity++;
        }
      };
    return step(0, input);
  }

  /** The test's own `$`: each call fires its event, as Claude Code, over every plugin; `ui.mount` and `ui.press` draw and press. */
  engine() {
    const fire = (event, input) => {
      if (OPS.has(event)) throw new Error(`$.${event} is a mods API call: a test cannot fire it, trigger it through a mod`);
      if (STREAMING.has(event)) {
        return async function*(this: Engine) {
          await this.load();
          return yield* this.dispatch(event, input, { origin: ENGINE }) as AsyncGenerator<unknown, unknown>;
        }.call(this);
      }
      return this.load().then(() => this.dispatch(event, input, { origin: ENGINE }));
    };
    return new Proxy({}, {
      get: (_, ns) =>
        new Proxy({}, {
          get: (_2, v) => {
            if (ns === "ui" && v === "mount") return (e) => this.load().then(() => this.mount(e));
            if (ns === "ui" && v === "press") return (t) => this.load().then(() => this.control("ui.press", t, "Button", (b) => b.props.onPress?.()));
            return (input = {}) => fire(`${String(ns)}.${String(v)}`, input);
          },
        }),
    });
  }

  /**
   * The `$` one hook invocation (or a stub's) gets: each mods API call fires its event beneath the caller, and
   * resolves to the chain's `{ value }` or rejects with its `{ deny }`. `end` closes the hook's frame: a call made
   * after it (a timer, an unawaited chain) comes from outside the hook, so none of the caller's hooks see it.
   */
  api(hook) {
    let running = true;
    const caller = { plugin: hook.plugin, idx: hook.idx, hook, active: () => running };
    const origin = Object.freeze({ plugin: hook.plugin, tier: hook.tier });
    const call = async (event, input, signal?: AbortSignal) => {
      await this.load();
      const r = await this.dispatch(event, input, { origin, caller, signal });
      if (r && typeof r === "object" && "deny" in r && r.deny !== undefined) throw new Error(String(r.deny));
      if (r && typeof r === "object" && "value" in r) return r.value;
      const err = new Error(`${event}: returned neither { value } nor { deny }`);
      this.fatal.push(err);
      throw err;
    };
    const input = (event, args) => {
      const names = POSITIONAL[event];
      if (!names) return args[0] ?? {};
      const out: Record<string, unknown> = {};
      names.forEach((n, i) => (n === "..." ? Object.assign(out, args[i]) : args[i] !== undefined && (out[n] = args[i])));
      return out;
    };
    // A timer: one dispatch per period, `fn` run as each resolves; cancel drops the held wait.
    const timer = (event, ms, fn, repeat) => {
      const ctl = new AbortController();
      (async () => {
        do {
          await call(event, { ms }, ctl.signal);
          if (ctl.signal.aborted) return;
          fn();
        } while (repeat);
      })().catch((err) => ctl.signal.aborted || this.report(hook, err));
      return { cancel: () => ctl.abort() };
    };
    const $ = new Proxy({}, {
      get: (_, ns) =>
        new Proxy({}, {
          get: (_2, v) => {
            const event = `${String(ns)}.${String(v)}`;
            if (event === "ui.resolve") return () => elements;
            if (event === "clock.every") return (ms, fn) => timer(event, ms, fn, true);
            if (event === "clock.after") return (ms, fn) => timer(event, ms, fn, false);
            if (event === "ui.invalidate") {
              return (...args) => void call(event, input(event, args)).catch((err) => this.report(hook, err));
            }
            return (...args) => {
              const p = call(event, input(event, args));
              // A call the mod never awaits (a void $.ui.log) rejects into the engine report, not as an unhandled rejection.
              p.catch((err) => this.reported.push(`in ${hook.plugin}'s ${hook.event} hook: $.${event} rejected: ${message(err)}`));
              return p;
            };
          },
        }),
    });
    return { $, end: () => (running = false) };
  }

  /** Draws a render site through the ui.render chain and returns the kit's handle on it. */
  async mount(e) {
    const site: Site = { e, tree: undefined, drawing: Promise.resolve(), mounted: true, redraw: () => undefined };
    const render = async () => {
      if (!site.mounted) return;
      this.activity++;
      site.tree = await this.dispatch("ui.render", e, { origin: ENGINE });
      this.activity++;
    };
    site.redraw = () => (site.drawing = site.drawing.then(render).catch((err) => this.reported.push(`ui.render: ${message(err)}`)));
    this.mounts.add(site);
    await render();
    const drawn = async () => {
      await site.drawing;
      return nodes(site.tree);
    };
    const use = (event, type, key, act) => this.control(event, { plugin: e.plugin, requestId: e.requestId, key }, type, act, site);
    return {
      find: async (q) => (await drawn()).find((n) => matches(n, q)),
      findAll: async (q = {}) => (await drawn()).filter((n) => matches(n, q)),
      press: ({ key }) => use("ui.press", "Button", key, (b) => b.props.onPress?.()),
      input: ({ key, text, kind }) => use("ui.input", "Input", key, (n) => (kind === "change" ? n.props.onInput?.(text) : n.props.onSubmit?.(text))),
      select: ({ key, value }) => use("ui.select", "Select", key, (n) => n.props.onSelect?.(value)),
      unmount: async () => {
        await site.drawing;
        site.mounted = false;
        this.mounts.delete(site);
      },
    };
  }

  /** Uses a drawn control: its event's chain over every plugin, the control's own handler at the bottom. */
  async control(event, target, type, act, site?: Site) {
    const sites = site ? [site] : [...this.mounts].filter((s) => s.e.plugin === target.plugin && (target.requestId === undefined || s.e.requestId === target.requestId));
    await Promise.all(sites.map((s) => s.drawing));
    const found = sites.flatMap((s) => nodes(s.tree)).filter((n) => n.type === type && n.props?.key === target.key);
    if (found.length !== 1) throw new Error(`${event}: ${found.length ? "several" : "no"} ${type} with key "${target.key}" is drawn`);
    const e = { plugin: target.plugin, requestId: target.requestId ?? sites[0]?.e.requestId, key: target.key };
    const r = await this.dispatch(event, e, { origin: ENGINE, bottom: async () => act(found[0]) });
    await Promise.all(sites.map((s) => s.drawing));
    return r;
  }

  /** Lets everything under way run as far as it can: until a full event-loop turn moves nothing. */
  async settle() {
    for (let n = 0;; n++) {
      if (n > 10_000) throw new Error("settle: work never stops (a zero-period timer?)");
      const before = this.activity;
      await new Promise((r) => setImmediate(r));
      await Promise.all([...this.mounts].map((s) => s.drawing));
      if (this.activity === before) return;
    }
  }
}

/**
 * Creates the kit for one hooks module.
 *
 * @param {{ module: URL, plugin: string, options?: object, tier?: string, runner?: Function }} cfg - The built hooks
 *   module, the plugin's name, the `options` every test's `register(on, options)` gets (a test's own `options` are
 *   merged over them), the tier it loads in (`user` when not given), and (for the kit's own tests) what stands for
 *   vitest's `test`.
 * @returns {{ test: Function, mock: object }} The kit's `test` and `mock`.
 */
export function createKit(cfg: EngineConfig) {
  /** The engine of the test running now: `mock.*` registers its stubs there through the `on` it is handed. */
  const engines = new WeakMap();

  /**
   * One test: `test(name, [options { options, plugins, timeoutMs }], async ($, on) => ...)`.
   *
   * @param {string} name - The test's name.
   * @param {...unknown} rest - The body, or the options then the body.
   */
  function test(name, ...rest) {
    const [opts, body] = rest.length === 1 ? [{}, rest[0]] : rest;
    (cfg.runner ?? vitestTest)(name, { timeout: opts.timeoutMs ?? 5000 }, async () => {
      const engine = new Engine({ ...cfg, options: { ...cfg.options, ...opts.options }, plugins: opts.plugins });
      engines.set(engine.stubOn, engine);
      try {
        await body(engine.engine(), engine.stubOn);
        if (engine.fatal.length) throw engine.fatal[0];
      } catch (err) {
        if (engine.reported.length && err && typeof err === "object") {
          (err as Error).message = `${(err as Error).message}\n\nthe engine reported:\n${engine.reported.map((l) => `  ${l}`).join("\n")}`;
        }
        throw err;
      }
    });
  }

  const engineOf = (on) => {
    const e = engines.get(on);
    if (!e) throw new Error("mock: pass the test's own on");
    return e;
  };

  const mock = {
    /**
     * Answers `$.clock` from a clock that moves only when the test moves it.
     *
     * @param {Function} on - The test's `on`.
     * @param {{ now?: number }} [options] - Where the clock starts (0 when not given).
     */
    clock(on, options: { now?: number } = {}) {
      const engine = engineOf(on);
      let now = options.now ?? 0;
      const waits: { due: number; seq: number; resolve: (v?: unknown) => void }[] = [];
      const wait = (ms: number, signal?: AbortSignal) =>
        new Promise((resolve) => {
          const w = { due: now + ms, seq: engine.seq++, resolve };
          waits.push(w);
          signal?.addEventListener("abort", () => {
            const i = waits.indexOf(w);
            if (i >= 0) waits.splice(i, 1); // a wait that already resolved is gone: never drop another timer's
          }, { once: true });
        });
      on("clock.now", () => ({ value: now }));
      for (const ev of ["clock.sleep", "clock.after", "clock.every"]) on(ev, async (_$, e, next) => (await wait(e.ms, next.signal), { value: undefined }));
      const advance = async (ms) => {
        const end = now + ms;
        await engine.settle();
        for (;;) {
          const due = waits.filter((w) => w.due <= end).sort((a, b) => a.due - b.due || a.seq - b.seq)[0];
          if (!due) break;
          waits.splice(waits.indexOf(due), 1);
          now = due.due;
          due.resolve();
          engine.activity++;
          await engine.settle();
        }
        now = end;
        await engine.settle();
      };
      return {
        now: () => now,
        advance,
        set: (ms) => advance(ms - now),
        settle: () => advance(0),
        sleep: (ms) => wait(ms),
      };
    },
    /**
     * Answers `$.store` from a store in memory.
     *
     * @param {Function} on - The test's `on`.
     * @param {Record<string, unknown>} [entries] - What the store holds at the start.
     */
    store(on, entries = {}) {
      const m = new Map(Object.entries(entries));
      on("store.get", (_$, e) => ({ value: m.get(e.key) }));
      on("store.set", (_$, e) => (m.set(e.key, e.value), { value: undefined }));
      on("store.delete", (_$, e) => (m.delete(e.key), { value: undefined }));
      on("store.keys", () => ({ value: [...m.keys()] }));
    },
    /**
     * Answers `$.env.get` from a set of variables; one not listed is unset.
     *
     * @param {Function} on - The test's `on`.
     * @param {Record<string, string>} variables - The environment.
     */
    env(on, variables) {
      on("env.get", (_$, e) => ({ value: variables[e.name] }));
    },
    /**
     * Records the rows the mods append with `$.session.append`.
     *
     * @param {Function} on - The test's `on`.
     * @returns {{ appended: () => unknown[] }} The rows, oldest first.
     */
    session(on) {
      const rows: unknown[] = [];
      on("session.append", (_$, e, next) => {
        if (next.origin.plugin !== "engine") rows.push(e);
        return next(e);
      });
      return { appended: () => [...rows] };
    },
  };

  return { test, mock };
}
