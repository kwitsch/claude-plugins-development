// The countdown example of the docs: a one-second timer that toasts at zero.
export function register(on) {
  on("command.run", { command: "countdown" }, async ($, e) => {
    let left = Number(e.args);
    const timer = $.clock.every(1000, () => {
      left -= 1;
      if (left === 0) {
        timer.cancel();
        $.ui.toast("Time is up");
      }
    });
    return {};
  });
}
