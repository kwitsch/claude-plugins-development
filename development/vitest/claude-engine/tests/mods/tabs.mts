// The hello-tabs pane of the docs: two tabs, the second counts presses and saves the count.
import type { On } from "../../index.mts";

export function register(on: On) {
  let tab = "one";
  on("ui.render", { component: "Pane", requestId: "hello-tabs" }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e);
    const count = Number((await $.store.get("count")) ?? 0);
    const press = (fn: () => unknown) => async () => {
      await fn();
      $.ui.invalidate("ui.render");
    };
    return Box({
      flexDirection: "column",
      children: [
        Button({ key: "tab-one", label: "One", onPress: press(() => (tab = "one")) }),
        Button({ key: "tab-two", label: "Two", onPress: press(() => (tab = "two")) }),
        ...(tab === "two" ? [Text({ children: [`Count: ${count}`] }), Button({ key: "more", label: "More", onPress: press(() => $.store.set("count", count + 1)) })] : [Text({ children: ["Hello"] })]),
      ],
    });
  });
}
