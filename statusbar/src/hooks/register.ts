/**
 * Claude Code function-hooks module of statusbar. Scaffold state: it passes the StatusLine render site through
 * unchanged; the line itself arrives with the formatter.
 *
 * @remarks
 * EARLY ACCESS API. No engine type import: the used events are typed structurally below.
 *
 * @packageDocumentation
 */

/** A `ui.render` event of the StatusLine site. */
type RenderEvent = Record<string, unknown>;
/** The `on` the engine passes to `register`. */
type On = {
  /** Registers the StatusLine render hook. */
  (event: "ui.render", matcher: { component: "StatusLine" }, hook: ($: unknown, e: RenderEvent, next: (e: RenderEvent) => unknown) => unknown): void;
};

/**
 * Registers the module's hooks.
 *
 * @param on - The engine's hook registration.
 */
export const register = (on: On): void => {
  on("ui.render", { component: "StatusLine" }, function render($, e, next) {
    return next(e);
  });
};
