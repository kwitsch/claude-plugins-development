const TOAST_MS = 15e3;
async function hasGraphmind($) {
	const [home, pathVar] = await Promise.all([$.env.get("HOME"), $.env.get("PATH")]);
	const dirs = (pathVar ?? "").split(":").filter((d) => d.startsWith("/"));
	if (home) dirs.push(`${home}/.graphmind/bin`, `${home}/.local/bin`);
	dirs.push("/usr/local/bin");
	const found = await Promise.all(dirs.map((d) => $.fs.exists(`${d.replace(/\/+$/, "")}/graphmind`)));
	return found.some(Boolean);
}
async function onSessionStart($, e, next) {
	const r = await next(e);
	void hasGraphmind($).then((found) => {
		if (!found) $.ui.toast("graphmind-helper: the graphmind binary was not found (PATH, ~/.graphmind/bin, ~/.local/bin); the plugin's hooks and MCP server stay off until it is installed (https://github.com/aouicher/graphmind)", { timeoutMs: TOAST_MS });
	}).catch(() => {});
	return r;
}
export const register = (on) => {
	on("session.start", onSessionStart);
};
