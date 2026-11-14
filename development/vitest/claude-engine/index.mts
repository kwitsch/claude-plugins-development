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

/** An event's input, and the fields a matcher compares. */
type Data = Record<string, unknown>;

/** What `$.clock.every` and `$.clock.after` return. */
type Timer = {
  /** Stops the timer: drops its held wait. */
  cancel: () => void;
};

/** The `next` a hook gets: calls the rest of the chain and carries the dispatch's context. */
interface Next {
  /** Runs the rest of the chain with `e`; returns its result (a Promise, or an async generator for a streaming event). */
  (e: Data): unknown;
  /** Who fired the event. */
  origin: Origin;
  /** The event name. */
  event: string;
  /** Aborted when the event's caller gives up (a cancelled timer). */
  signal: AbortSignal;
  /** Why the hook failed; set only for a `.catch` handler. */
  error?: { kind: string; message: string };
  /** Whether the failed hook had called `next`; set only for a `.catch` handler. */
  called?: boolean;
}

/** A hook function as a mod registers it (or a test stub): its `$`, the event's input and `next`. */
type HookFn = ($: HookApi, e: Data, next: Next) => unknown;

/** What `on(...)` returns. */
interface Registration {
  /** Sets the handler that answers in place of the hook when it throws. */
  catch: (handler: HookFn) => void;
}

/** The `on` a mod's `register` (and a test) gets: `on(event, fn)` or `on(event, matcher, fn)`. */
export interface On {
  /** Hooks `event` (a name, `ns.*` or `*`). */
  (event: string, fn: HookFn): Registration;
  /** Hooks `event` for inputs holding every field of `matcher`. */
  (event: string, matcher: Data, fn: HookFn): Registration;
}

/** A mods API call or a fired event: resolves to its result. */
type Call = (...args: unknown[]) => Promise<unknown>;

/** The `$` a hook gets; each namespace with own members also takes every other name as a `Call`. */
type HookApi = {
  /** Drawing. */
  ui: {
    /** The element factories of a render site. */
    resolve: (e?: unknown) => Record<string, (props?: Data) => UiElement>;
    /** Queues a redraw of the sites of an event. */
    invalidate: (...args: unknown[]) => void;
  } & Record<string, Call>;
  /** Timers. */
  clock: {
    /** Runs `fn` every `ms`. */
    every: (ms: number, fn: () => unknown) => Timer;
    /** Runs `fn` once after `ms`. */
    after: (ms: number, fn: () => unknown) => Timer;
  } & Record<string, Call>;
} & Record<string, Record<string, Call>>;

/** A test's `$` call: fires its event as Claude Code and resolves to the chain's result. */
type Fire = (input?: Data) => Promise<unknown>;

/** The test's own `$`: fires events as Claude Code; each namespace with own members also takes every other name as a `Fire`. */
type TestApi = {
  /** Render sites. */
  ui: {
    /** Draws a render site through the ui.render chain. */
    mount: (e: Data) => Promise<Mounted>;
    /** Presses the drawn Button `key` of a mounted site of `plugin`. */
    press: (target: { plugin: string; requestId?: string; key: string }) => Promise<unknown>;
  } & Record<string, Fire>;
  /** Turns. */
  turn: {
    /** Fires the streaming turn.step event. */
    step: (input?: Data) => AsyncGenerator<unknown, unknown>;
  } & Record<string, Fire>;
  /** Processes. */
  process: {
    /** Fires the streaming process.spawn event. */
    spawn: (input?: Data) => AsyncGenerator<unknown, unknown>;
  } & Record<string, Fire>;
} & Record<string, Record<string, Fire>>;

/** A find query: every given field must match; a string `text` is a substring match. */
interface Query {
  /** The element name. */
  type?: string;
  /** Its text (string children, nested elements included). */
  text?: string | RegExp;
  /** Its `key` prop. */
  key?: string;
}

/** The handle `$.ui.mount` returns. */
interface Mounted {
  /** The first drawn element matching `q`. */
  find(q: Query): Promise<UiElement | undefined>;
  /** Every drawn element matching `q`. */
  findAll(q?: Query): Promise<UiElement[]>;
  /** Presses the drawn Button `key`. */
  press(t: { key: string }): Promise<unknown>;
  /** Types `text` into the drawn Input `key` (`kind: "change"` for onInput, else onSubmit). */
  input(t: { key: string; text: string; kind?: string }): Promise<unknown>;
  /** Selects `value` in the drawn Select `key`. */
  select(t: { key: string; value: unknown }): Promise<unknown>;
  /** Unmounts the site after its last draw. */
  unmount(): Promise<void>;
}

/** A test's own options. */
interface TestOptions {
  /** Merged over the kit's `options`. */
  options?: Data;
  /** Inline plugins loaded with the module. */
  plugins?: Plugin[];
  /** The test's timeout (5000 when not given). */
  timeoutMs?: number;
}

/** A test body: the test's `$` and `on`. */
type Body = ($: TestApi, on: On) => unknown;

/** Who calls a mods API from inside a hook. */
interface Caller {
  /** The calling plugin. */
  plugin: string;
  /** Its load order. */
  idx: number;
  /** The calling hook. */
  hook: Hook;
  /** false once the hook's frame has ended. */
  active: () => boolean;
}

/** How one dispatch is fired. */
interface Ctx {
  /** Who fires it. */
  origin: Origin;
  /** The calling hook, for a mods API call. */
  caller?: Caller;
  /** Aborted when the caller gives up. */
  signal?: AbortSignal;
  /** The answer beneath the chain (the kit's own when not given). */
  bottom?: (e: Data) => unknown;
}

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
  matcher?: Data;
  /** The hook. */
  fn: HookFn;
  /** The handler set by `.catch(handler)`. */
  catcher?: HookFn;
}

/** A mounted render site. */
interface Site {
  /** The ui.render event it was mounted with. */
  e: Data;
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
  options?: Data;
  /** Inline plugins loaded with it. */
  plugins?: Plugin[];
  /** What stands for vitest's `test` (the kit's own tests). */
  runner?: (name: string, opts: { timeout: number }, fn: () => Promise<void>) => void;
}

const ENGINE: Origin = Object.freeze({ plugin: "engine", tier: "core" });
const TIERS = ["prepend", "user", "append", "builtin"];
const STREAMING = new Set(["turn.step", "process.spawn"]);
// Positional arguments of each mods API call, as its event's input fields ("..." spreads an options object).
const POSITIONAL: Record<string, string[] | undefined> = {
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

/** Whether `v` is a non-null object: an event input, a matcher, a tree node. */
const isData = (v: unknown): v is Data => typeof v === "object" && v !== null;

/** Whether `v` is callable (a handler prop such as `onPress`, a module's `register`). */
const isCallable = (v: unknown): v is (...args: unknown[]) => unknown => typeof v === "function";

/** Deep-freezes `o` in place. */
const freeze = (o: unknown): void => {
  if (isData(o) && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const k of Object.keys(o)) freeze(o[k]);
  }
};

/** Deep-freezes a copy of `v`, as the engine hands each hook its input; values structuredClone refuses stay as they are. */
const frozen = <T,>(v: T): T => {
  let c = v;
  try {
    c = structuredClone(v);
  } catch {
    // functions inside (a Button's onPress): freeze in place
  }
  freeze(c);
  return c;
};

/** Whether `e` holds every field of `matcher` (nested objects compared field by field). */
const fits = (matcher: Data | undefined, e: unknown): boolean =>
  matcher === undefined || Object.entries(matcher).every(([k, m]) => {
    const v = isData(e) ? e[k] : undefined;
    return isData(m) ? isData(v) && fits(m, v) : v === m;
  });

/** Whether an `on` pattern (a name, `ns.*` or `*`) selects `event`. */
const selects = (pattern: string, event: string): boolean => pattern === event || pattern === "*" || (pattern.endsWith(".*") && event.startsWith(pattern.slice(0, -1)));

/**
 * Splits `on(event, fn)` / `on(event, matcher, fn)` arguments.
 *
 * @param event - The `on` pattern, for the error message.
 * @param a - The hook, or the matcher when `b` is given.
 * @param b - The hook after a matcher.
 * @returns The hook and its matcher (undefined without one).
 */
const parseOn = (event: string, a: HookFn | Data, b?: HookFn): { fn: HookFn; matcher: Data | undefined } => {
  const fn = b ?? a;
  if (typeof fn !== "function") throw new TypeError(`on("${event}"): no hook function`);
  return { fn, matcher: b === undefined || typeof a === "function" ? undefined : a };
};

/** Whether `err` is a failed assertion (node:assert or vitest's expect). */
const isAssertion = (err: unknown): boolean => isData(err) && (err.name === "AssertionError" || err.matcherResult !== undefined);

/** The message of `err`. */
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The concatenated text of an element's string children, nested elements included. */
const textOf = (n: unknown): string => {
  const children: unknown[] = isData(n) && Array.isArray(n.children) ? n.children : [];
  return children.map((c) => (typeof c === "string" || typeof c === "number" ? String(c) : isData(c) ? textOf(c) : "")).join("");
};

/** Whether `n` is a drawn element (an object with a string `type`). */
const isElement = (n: unknown): n is UiElement => isData(n) && typeof n.type === "string";

/** Every element of a tree, depth first. */
const nodes = (n: unknown, out: UiElement[] = []): UiElement[] => {
  if (Array.isArray(n)) {
    for (const c of n) nodes(c, out);
  } else if (isElement(n)) {
    out.push(n);
    nodes(n.children ?? [], out);
  }
  return out;
};

/** Whether element `n` matches a find query `{ type, text, key }`; a string `text` is a substring match. */
const matches = (n: UiElement, q: Query): boolean =>
  (q.type === undefined || n.type === q.type) && (q.key === undefined || n.props?.key === q.key)
  && (q.text === undefined || (q.text instanceof RegExp ? q.text.test(textOf(n)) : textOf(n).includes(q.text)));

/** Runs element `n`'s handler prop `name` with `args`; nothing when it has none. */
const handle = (n: UiElement, name: string, ...args: unknown[]): unknown => {
  const f = n.props[name];
  return isCallable(f) ? f(...args) : undefined;
};

/** `$.ui.resolve(e)`: every element name is a factory turning props into plain `{ type, props, children }` data. */
// The Proxy answers every string key with a factory; TypeScript cannot see that.
const elements = new Proxy({}, {
  get: (_, type) =>
    typeof type === "string"
      ? (props: Data = {}): UiElement => {
        const { children, ...rest } = props;
        return { type, props: rest, children: children === undefined ? [] : [children].flat() };
      }
      : undefined,
}) as Record<string, (props?: Data) => UiElement>;

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
  stubOn = (event: string, a: HookFn | Data, b?: HookFn): Registration => {
    if (this.started) throw new Error(`on("${event}") after the test first called $`);
    const { fn, matcher } = parseOn(event, a, b);
    const hook: Hook = { plugin: "test", tier: "core", idx: Infinity, event, matcher, fn };
    this.stubs.push(hook);
    return { catch: (handler) => void (hook.catcher = handler) };
  };

  /** Loads every plugin once, at the test's first call on `$`: a fresh instance of the module under test, then inline ones. */
  load() {
    this.started = true;
    this.loading ??= (async () => {
      const href = this.cfg.module.href;
      const mod: unknown = await import(`${href}${this.cfg.module.search ? "&" : "?"}claude-engine-vitest=${loads++}`);
      const register = isData(mod) ? mod.register : undefined;
      if (!isCallable(register)) throw new Error(`${href}: exports no register function`);
      const list: { name: string; tier: string; register: Plugin["register"]; options: unknown }[] = [
        { name: this.cfg.plugin, tier: this.cfg.tier ?? "user", register, options: this.cfg.options },
        ...(this.cfg.plugins ?? []).map((p) => ({ ...p, tier: p.tier ?? "user", options: {} })),
      ];
      list.sort((x, y) => TIERS.indexOf(x.tier) - TIERS.indexOf(y.tier));
      list.forEach((p, idx) => {
        const bare = new Set<string>();
        p.register((event: string, a: HookFn | Data, b?: HookFn): Registration => {
          const { fn, matcher } = parseOn(event, a, b);
          if (matcher === undefined) {
            if (bare.has(event)) throw new Error(`${p.name}: ${event} registered twice without a matcher`);
            bare.add(event);
          }
          const hook: Hook = { plugin: p.name, tier: p.tier, idx, event, matcher, fn };
          this.hooks.push(hook);
          return { catch: (handler) => void (hook.catcher = handler) };
        }, p.options ?? {});
      });
    })();
    return this.loading;
  }

  /**
   * Records a failing hook in the engine report; an assertion failing inside one fails the test.
   *
   * @param hook - The failing hook.
   * @param err - What it threw.
   */
  report(hook: Hook, err: unknown): void {
    const where = hook.plugin === "test" ? `the test's ${hook.event} hook` : `${hook.plugin}'s ${hook.event} hook`;
    this.reported.push(`in ${where}: ${message(err)}`);
    if (isAssertion(err)) this.fatal.push(err);
  }

  /**
   * The hooks one dispatch runs, in order: the plugins' (for a mods API call only those at or above the caller, the
   * calling hook skipped, or every hook of the caller when it called from outside a hook), then the test's stubs.
   *
   * @param event - The event name.
   * @param e - The event's input.
   * @param caller - The calling hook, for a mods API call.
   */
  chain(event: string, e: Data, caller?: Caller): Hook[] {
    const plugins = this.hooks.filter((h) => {
      if (!selects(h.event, event) || !fits(h.matcher, e)) return false;
      if (!caller) return true;
      if (h.idx > caller.idx) return false;
      return h.plugin !== caller.plugin || (caller.hook !== undefined && caller.hook !== h && caller.active());
    });
    return [...plugins, ...this.stubs.filter((h) => selects(h.event, event) && fits(h.matcher, e))];
  }

  /**
   * The kit's own answer beneath the stubs: `no implementation for <event>`, except for the calls the kit answers.
   *
   * @param event - The event name.
   * @param e - The event's input.
   */
  bottom(event: string, e: Data): unknown {
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
   * @param event - The event name.
   * @param input - The event's input.
   * @param ctx - Who fires it.
   */
  dispatch(event: string, input: Data, ctx: Ctx): Promise<unknown> | AsyncGenerator<unknown, unknown> {
    const hooks = this.chain(event, input, ctx.caller);
    const signal = ctx.signal ?? new AbortController().signal;
    const bottom = ctx.bottom ?? ((e: Data) => this.bottom(event, e));
    // `sig` is the signal hook i sees, `below` the one the rest of the chain gets from its next.
    const nextFor = (i: number, called: { value: boolean }, sig = signal, below = signal): Next => Object.assign((e2: Data) => (called.value = true, step(i + 1, e2, below)), { origin: ctx.origin, event, signal: sig });
    const stream = async function*(this: Engine, i: number, e: Data, _sig?: AbortSignal): AsyncGenerator<unknown, unknown> {
      this.activity++;
      if (i === hooks.length) return await bottom(e);
      const h = hooks[i];
      const called = { value: false };
      const { $, end } = this.api(h);
      try {
        return yield* h.fn($, frozen(e), nextFor(i, called)) as AsyncGenerator<unknown, unknown>;
      } catch (err) {
        if (h.catcher) {
          try {
            return yield* h.catcher($, frozen(e), Object.assign(nextFor(i, called), { error: { kind: "throw", message: message(err) }, called: called.value })) as AsyncGenerator<unknown, unknown>;
          } catch {
            // the handler failed too: skip the hook as without one
          }
        }
        this.report(h, err);
        if (called.value) throw err;
        return yield* stream.call(this, i + 1, e);
      } finally {
        end();
      }
    };
    const step = STREAMING.has(event)
      ? stream.bind(this)
      : async (i: number, e: Data, sig = signal): Promise<unknown> => {
        this.activity++;
        if (i === hooks.length) return bottom(e);
        const h = hooks[i];
        const called = { value: false };
        let pending: unknown;
        let settled = false;
        // The rest of the chain is abandoned (its next.signal aborts) when this hook settles before its next does, or when this hook's own dispatch is abandoned.
        const below = new AbortController();
        sig.addEventListener("abort", () => below.abort(), { once: true });
        const next = nextFor(i, called, sig, below.signal);
        const tracked = Object.assign((e2: Data) => {
          pending = next(e2);
          void Promise.resolve(pending).then(() => (settled = true), () => (settled = true));
          return pending;
        }, next);
        const { $, end } = this.api(h);
        try {
          const r = await h.fn($, frozen(e), tracked);
          if (pending && !settled) below.abort();
          return r;
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
  engine(): TestApi {
    const fire = (event: string, input: Data): Promise<unknown> | AsyncGenerator<unknown, unknown> => {
      if (OPS.has(event)) throw new Error(`$.${event} is a mods API call: a test cannot fire it, trigger it through a mod`);
      if (STREAMING.has(event)) {
        return async function*(this: Engine) {
          await this.load();
          return yield* this.dispatch(event, input, { origin: ENGINE }) as AsyncGenerator<unknown, unknown>;
        }.call(this);
      }
      return this.load().then(() => this.dispatch(event, input, { origin: ENGINE }));
    };
    // The Proxy answers every namespace and member; TypeScript cannot see that.
    return new Proxy({}, {
      get: (_, ns) =>
        new Proxy({}, {
          get: (_2, v) => {
            if (ns === "ui" && v === "mount") return (e: Data) => this.load().then(() => this.mount(e));
            if (ns === "ui" && v === "press") {
              return (t: { plugin: string; requestId?: string; key: string }) => this.load().then(() => this.control("ui.press", t, "Button", (b) => handle(b, "onPress")));
            }
            return (input: Data = {}) => fire(`${String(ns)}.${String(v)}`, input);
          },
        }),
    }) as TestApi;
  }

  /**
   * The `$` one hook invocation (or a stub's) gets: each mods API call fires its event beneath the caller, and
   * resolves to the chain's `{ value }` or rejects with its `{ deny }`. `end` closes the hook's frame: a call made
   * after it (a timer, an unawaited chain) comes from outside the hook, so none of the caller's hooks see it.
   *
   * @param hook - The hook the `$` is for.
   */
  api(hook: Hook): { $: HookApi; end: () => boolean } {
    let running = true;
    const caller: Caller = { plugin: hook.plugin, idx: hook.idx, hook, active: () => running };
    const origin = Object.freeze({ plugin: hook.plugin, tier: hook.tier });
    const call = async (event: string, input: Data, signal?: AbortSignal): Promise<unknown> => {
      await this.load();
      const r: unknown = await this.dispatch(event, input, { origin, caller, signal });
      if (r && typeof r === "object" && "deny" in r && r.deny !== undefined) throw new Error(message(r.deny));
      if (r && typeof r === "object" && "value" in r) return r.value;
      const err = new Error(`${event}: returned neither { value } nor { deny }`);
      this.fatal.push(err);
      throw err;
    };
    const input = (event: string, args: unknown[]): Data => {
      const names = POSITIONAL[event];
      if (!names) {
        const first = args[0] ?? {};
        return isData(first) ? first : {};
      }
      const out: Data = {};
      names.forEach((n, i) => (n === "..." ? Object.assign(out, args[i]) : args[i] !== undefined && (out[n] = args[i])));
      return out;
    };
    // A timer: one dispatch per period, `fn` run as each resolves; cancel drops the held wait.
    const timer = (event: string, ms: number, fn: () => unknown, repeat: boolean): Timer => {
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
    // The Proxy answers every namespace and member; TypeScript cannot see that.
    const $ = new Proxy({}, {
      get: (_, ns) =>
        new Proxy({}, {
          get: (_2, v) => {
            const event = `${String(ns)}.${String(v)}`;
            if (event === "ui.resolve") return () => elements;
            if (event === "clock.every") return (ms: number, fn: () => unknown) => timer(event, ms, fn, true);
            if (event === "clock.after") return (ms: number, fn: () => unknown) => timer(event, ms, fn, false);
            if (event === "ui.invalidate") {
              return (...args: unknown[]) => void call(event, input(event, args)).catch((err) => this.report(hook, err));
            }
            return (...args: unknown[]) => {
              const p = call(event, input(event, args));
              // A call the mod never awaits (a void $.ui.log) rejects into the engine report, not as an unhandled rejection.
              p.catch((err) => this.reported.push(`in ${hook.plugin}'s ${hook.event} hook: $.${event} rejected: ${message(err)}`));
              return p;
            };
          },
        }),
    }) as HookApi;
    return { $, end: () => (running = false) };
  }

  /**
   * Draws a render site through the ui.render chain and returns the kit's handle on it.
   *
   * @param e - The ui.render event.
   */
  async mount(e: Data): Promise<Mounted> {
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
    const use = (event: string, type: string, key: string, act: (n: UiElement) => unknown) => this.control(event, { plugin: e.plugin, requestId: e.requestId, key }, type, act, site);
    return {
      find: async (q) => (await drawn()).find((n) => matches(n, q)),
      findAll: async (q = {}) => (await drawn()).filter((n) => matches(n, q)),
      press: ({ key }) => use("ui.press", "Button", key, (b) => handle(b, "onPress")),
      input: ({ key, text, kind }) => use("ui.input", "Input", key, (n) => (kind === "change" ? handle(n, "onInput", text) : handle(n, "onSubmit", text))),
      select: ({ key, value }) => use("ui.select", "Select", key, (n) => handle(n, "onSelect", value)),
      unmount: async () => {
        await site.drawing;
        site.mounted = false;
        this.mounts.delete(site);
      },
    };
  }

  /**
   * Uses a drawn control: its event's chain over every plugin, the control's own handler at the bottom.
   *
   * @param event - The control's event (ui.press, ui.input, ui.select).
   * @param target - The plugin (and render site) and the control's key.
   * @param type - The control's element name.
   * @param act - Runs the control's own handler.
   * @param site - The one site to look in (every mounted site of the plugin when not given).
   */
  async control(event: string, target: { plugin: unknown; requestId?: unknown; key: string }, type: string, act: (n: UiElement) => unknown, site?: Site): Promise<unknown> {
    const sites = site ? [site] : [...this.mounts].filter((s) => s.e.plugin === target.plugin && (target.requestId === undefined || s.e.requestId === target.requestId));
    await Promise.all(sites.map((s) => s.drawing));
    const found = sites.flatMap((s) => nodes(s.tree)).filter((n) => n.type === type && n.props?.key === target.key);
    if (found.length !== 1) throw new Error(`${event}: ${found.length ? "several" : "no"} ${type} with key "${target.key}" is drawn`);
    const e = { plugin: target.plugin, requestId: target.requestId ?? sites[0]?.e.requestId, key: target.key };
    const r = await this.dispatch(event, e, { origin: ENGINE, bottom: () => act(found[0]) });
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
 * @param cfg - The hooks module and plugin every test loads; a test's own `options` are merged over `cfg.options`.
 * @returns The kit's `test` and `mock`.
 */
export function createKit(cfg: EngineConfig) {
  /** The engine of the test running now: `mock.*` registers its stubs there through the `on` it is handed. */
  const engines = new WeakMap<On, Engine>();
  /** What runs each test: the config's runner, or vitest's `test`. */
  const run = cfg.runner ?? ((n: string, o: { timeout: number }, f: () => Promise<void>) => vitestTest(n, o, f));

  /**
   * One test: `test(name, [options { options, plugins, timeoutMs }], async ($, on) => ...)`.
   *
   * @param name - The test's name.
   * @param a - The body, or the test's options.
   * @param b - The body, after the options.
   */
  function test(name: string, body: Body): void;
  function test(name: string, opts: TestOptions, body: Body): void;
  function test(name: string, a: TestOptions | Body, b?: Body): void {
    const opts = typeof a === "function" ? {} : a;
    const body = typeof a === "function" ? a : b;
    run(name, { timeout: opts.timeoutMs ?? 5000 }, async () => {
      const engine = new Engine({ ...cfg, options: { ...cfg.options, ...opts.options }, plugins: opts.plugins });
      engines.set(engine.stubOn, engine);
      try {
        if (!body) throw new TypeError("body is not a function");
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

  /**
   * The engine whose test was handed `on`.
   *
   * @param on - The test's `on`.
   */
  const engineOf = (on: On): Engine => {
    const e = engines.get(on);
    if (!e) throw new Error("mock: pass the test's own on");
    return e;
  };

  const mock = {
    /**
     * Answers `$.clock` from a clock that moves only when the test moves it.
     *
     * @param on - The test's `on`.
     * @param options - Where the clock starts (0 when not given).
     */
    clock(on: On, options: { now?: number } = {}) {
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
      for (const ev of ["clock.sleep", "clock.after", "clock.every"]) on(ev, async (_$, e, next) => (await wait(Number(e.ms), next.signal), { value: undefined }));
      const advance = async (ms: number) => {
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
        set: (ms: number) => advance(ms - now),
        settle: () => advance(0),
        sleep: (ms: number) => wait(ms),
      };
    },
    /**
     * Answers `$.store` from a store in memory.
     *
     * @param on - The test's `on`.
     * @param entries - What the store holds at the start.
     */
    store(on: On, entries: Data = {}) {
      const m = new Map<string, unknown>(Object.entries(entries));
      on("store.get", (_$, e) => ({ value: m.get(String(e.key)) }));
      on("store.set", (_$, e) => (m.set(String(e.key), e.value), { value: undefined }));
      on("store.delete", (_$, e) => (m.delete(String(e.key)), { value: undefined }));
      on("store.keys", () => ({ value: [...m.keys()] }));
    },
    /**
     * Answers `$.env.get` from a set of variables; one not listed is unset.
     *
     * @param on - The test's `on`.
     * @param variables - The environment.
     */
    env(on: On, variables: Record<string, string | undefined>) {
      on("env.get", (_$, e) => ({ value: variables[String(e.name)] }));
    },
    /**
     * Records the rows the mods append with `$.session.append`.
     *
     * @param on - The test's `on`.
     * @returns The rows, oldest first.
     */
    session(on: On) {
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
