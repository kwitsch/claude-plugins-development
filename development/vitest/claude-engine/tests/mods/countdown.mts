// The countdown example of the docs: a one-second timer that toasts at zero.
import type { On } from "../../index.mts";

export function register(on: On) {
  on("command.run", { command: "countdown" }, ($, e) => {
    let left = Number(e.args);
    const timer: { cancel: () => void } = $.clock.every(1000, () => {
      left -= 1;
      if (left === 0) {
        timer.cancel();
        void $.ui.toast("Time is up");
      }
    });
    return {};
  });
}
