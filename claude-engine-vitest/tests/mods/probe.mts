// A probe for the kit's own semantics: origins, a throwing hook, an unanswered call, a mods API call another plugin hooks.
export function register(on, options) {
  on("command.run", { command: "origin" }, async (_$, _e, next) => ({ text: JSON.stringify(next.origin) }));
  on("command.run", { command: "options" }, async () => ({ text: JSON.stringify(options) }));
  on("command.run", { command: "store" }, async ($) => {
    try {
      return { text: String(await $.store.get("k")) };
    } catch (err) {
      return { text: `rejected: ${(err as Error).message}` };
    }
  });
  on("command.run", { command: "unhandled" }, async ($) => ({ text: await $.store.get("k") }));
  on("tool.call", async () => {
    throw new Error("probe broke");
  });
  on("ui.close", { id: "p" }, async (_$, e, next) => {
    const r = await next(e);
    return { value: `probe saw ${JSON.stringify(r)} from ${e.id}` };
  });
}
