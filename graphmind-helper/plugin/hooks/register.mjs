import { entryId, fit, isCodePrompt, isRecallable, listing, NUDGE, resolveTools, searchTerms, SETUP_SCRIPTS, shouldNudge } from "./terms.mjs";
const TOAST_MS = 15e3;
const TOOLS_TTL_MS = 3e4;
const NOT_READY_TTL_MS = 3e4;
const SEARCH_TTL_MS = 18e4;
const RUN_MS = 1e4;
const CHECKPOINT_EVERY = 10;
let state = fresh();
function fresh() {
	return {
		ready: new Map(),
		briefed: false,
		nudged: false,
		turns: 0,
		shown: new Set(),
		searched: new Map()
	};
}
function textOf(r) {
	return r.deny === undefined && r.isError !== true && typeof r.result === "string" ? r.result : undefined;
}
async function binaryCandidates($) {
	const [home, pathVar] = await Promise.all([$.env.get("HOME"), $.env.get("PATH")]);
	const dirs = (pathVar ?? "").split(":").filter((d) => d.startsWith("/"));
	if (home) dirs.push(`${home}/.graphmind/bin`, `${home}/.local/bin`);
	dirs.push("/usr/local/bin");
	return dirs.map((d) => `${d.replace(/\/+$/, "")}/graphmind`);
}
async function graphmindBin($) {
	if (state.bin) return state.bin;
	const candidates = await binaryCandidates($);
	const found = await Promise.all(candidates.map((p) => $.fs.exists(p)));
	state.bin = candidates.find((_, i) => found[i]);
	return state.bin;
}
async function cli($, bin, args, cwd) {
	try {
		const r = await $.process.run([bin, ...args], {
			cwd,
			timeoutMs: RUN_MS
		});
		return r.exitCode === 0 ? r.stdout : "";
	} catch {
		return "";
	}
}
async function setupWired($) {
	if (state.wired !== undefined) return state.wired;
	let wired = false;
	try {
		const home = await $.env.get("HOME");
		const file = home ? `${home}/.claude/settings.json` : "";
		if (file && await $.fs.exists(file)) {
			const text = await $.fs.read(file);
			wired = SETUP_SCRIPTS.some((s) => text.includes(s));
		}
	} catch {}
	state.wired = wired;
	return wired;
}
async function graphmindTools($) {
	const now = await $.clock.now();
	if (state.tools && now - state.tools.at < TOOLS_TTL_MS) return state.tools.tools;
	const tools = resolveTools(await $.tool.list().catch(() => []));
	state.tools = tools ? {
		at: now,
		tools
	} : undefined;
	return tools;
}
async function projectReady($, tools, cwd) {
	const now = await $.clock.now();
	const known = state.ready.get(cwd);
	if (known && (known.ok || now - known.at < NOT_READY_TTL_MS)) return known.ok;
	const ok = textOf(await $.tool.call({
		tool: tools.status,
		project: cwd
	}).catch(() => ({ deny: "failed" }))) !== undefined;
	if (state.ready.size > 20) state.ready.clear();
	state.ready.set(cwd, {
		ok,
		at: now
	});
	return ok;
}
async function recallFor($, prompt) {
	if (!isRecallable(prompt) || await setupWired($)) return [];
	const bin = await graphmindBin($);
	const tools = bin ? await graphmindTools($) : undefined;
	if (!bin || !tools) return [];
	const cwd = await $.session.cwd();
	if (!await projectReady($, tools, cwd)) return [];
	const now = await $.clock.now();
	state.turns++;
	const checkpoint = state.turns % CHECKPOINT_EVERY === 0 ? `[graphmind checkpoint — prompt ${state.turns}] Review the last ${CHECKPOINT_EVERY} prompts. Call gm_session_analyze with an array of facts (decisions, conventions, bugs, constraints) that emerged — it batch-saves and deduplicates in one call. Use priority=true for facts needed every session.\n\n` : "";
	const text = async (tool, input) => textOf(await $.tool.call({
		tool,
		project: cwd,
		...input
	}).catch(() => ({ deny: "failed" }))) ?? "";
	const priorityRaw = await cli($, bin, [
		"memory",
		"list",
		"--priority",
		"--limit",
		"20",
		"--max-chars",
		"250"
	], cwd);
	const priority = listing(priorityRaw);
	let head = checkpoint;
	const blocks = [];
	if (!state.briefed) {
		const [status, map, recent] = await Promise.all([
			text(tools.status, {}),
			text(tools.map, { limit: 20 }),
			text(tools.memoryList, { limit: 5 })
		]);
		head = `[graphmind] Project indexed and ready. Use MCP tools (gm_search, gm_fn, gm_deps, gm_map, gm_outline, gm_query) for code exploration.\n\n${checkpoint}`;
		blocks.push({
			title: "Project status:",
			lines: status.split("\n").slice(0, 10)
		}, {
			title: "Structure:",
			lines: map.split("\n").slice(0, 20)
		}, {
			title: "★ Priority context (always active):",
			lines: priority
		}, {
			title: "Recent memories:",
			lines: listing(recent).slice(0, 5)
		}, {
			title: "Auto-memory is ON: save decisions/patterns/conventions via gm_memory_add. Use --priority for always-injected facts. Recall via gm_memory_search.",
			lines: []
		});
	} else {
		blocks.push({
			title: "[graphmind ★ new priority context]",
			lines: priority.filter((l) => !state.shown.has(entryId(l) ?? ""))
		});
	}
	const terms = searchTerms(prompt);
	const last = terms ? state.searched.get(terms) : undefined;
	if (terms && (last === undefined || now - last >= SEARCH_TTL_MS)) {
		if (state.searched.size > 50) state.searched.clear();
		state.searched.set(terms, now);
		const memory = listing(await cli($, bin, [
			"memory",
			"search",
			terms,
			"--limit",
			"5",
			"--max-chars",
			"300",
			"--no-recall"
		], cwd)).filter((l) => !l.startsWith("!")).slice(0, 5);
		const code = isCodePrompt(prompt) ? (await text(tools.search, {
			query: terms,
			limit: 5,
			code_only: true
		})).split("\n").slice(0, 30) : [];
		blocks.splice(blocks.length - 1, 0, {
			title: "[graphmind memory] Relevant:",
			lines: memory
		}, {
			title: "[graphmind code] Relevant symbols:",
			lines: code
		});
	}
	const out = fit(head, blocks);
	for (const l of priority) {
		const id = entryId(l);
		if (id && out.whole.has(l)) state.shown.add(id);
	}
	state.briefed = true;
	return out.text.trim() ? [out.text.trimEnd()] : [];
}
async function onSessionStart($, e, next) {
	state = fresh();
	const r = await next(e);
	void graphmindBin($).then((bin) => {
		if (!bin) $.ui.toast("graphmind-helper: the graphmind binary was not found (PATH, ~/.graphmind/bin, ~/.local/bin); the plugin's recall, nudge and MCP server stay off until it is installed (https://github.com/aouicher/graphmind)", { timeoutMs: TOAST_MS });
	}).catch(() => {});
	return r;
}
async function onSessionEnd(_$, e, next) {
	state = fresh();
	return next(e);
}
async function onPromptSubmit($, e, next) {
	if (e.origin?.kind === "plugin" || e.isMeta || e.command) return next(e);
	const added = await recallFor($, e.text).catch(() => []);
	return next(added.length ? {
		...e,
		context: [...e.context ?? [], ...added]
	} : e);
}
async function onToolCall($, e, next) {
	const r = await next(e);
	if (state.nudged || !shouldNudge(e)) return r;
	try {
		if (await setupWired($)) {
			state.nudged = true;
			return r;
		}
		const bin = await graphmindBin($);
		const tools = bin ? await graphmindTools($) : undefined;
		if (!tools || !await projectReady($, tools, await $.session.cwd())) return r;
		state.nudged = true;
		return {
			...r,
			context: [...Array.isArray(r.context) ? r.context : [], NUDGE]
		};
	} catch {
		return r;
	}
}
export const register = (on) => {
	on("session.start", onSessionStart);
	on("session.end", onSessionEnd);
	on("prompt.submit", onPromptSubmit);
	on("tool.call", onToolCall);
};
