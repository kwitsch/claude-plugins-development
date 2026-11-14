import { SPECS } from "./tools.mjs";
import { TOOLS } from "./types.mjs";
import { message } from "./util.mjs";
export const REGISTER_WAIT_MS = 1e3;
export const MAX_RETRY_MS = 3e5;
export const RETRY_BASE_MS = 5e3;
export async function registerOne($, st, type) {
	try {
		const r = await $.tool.register({
			name: type,
			...SPECS[type]
		});
		const tool = r?.tool;
		if (typeof tool === "string" && tool.startsWith("mcp__") && tool.endsWith(`__${type}`)) st.names.set(tool, type);
		st.missing.delete(type);
	} catch (err) {
		const n = (st.failures.get(type) ?? 0) + 1;
		st.failures.set(type, n);
		st.retryAt.set(type, Date.now() + (n === 1 ? 0 : Math.min(MAX_RETRY_MS, RETRY_BASE_MS * 2 ** (n - 2))));
		if (n === 1) {
			try {
				void Promise.resolve($.ui.log(`registering ${type} failed: ${message(err)}`)).catch(() => undefined);
			} catch {}
		}
	}
}
export async function ensureTools($, st, ms) {
	const now = Date.now();
	for (const type of TOOLS) {
		if (!st.missing.has(type) || st.pending.has(type) || (st.retryAt.get(type) ?? 0) > now) continue;
		const p = registerOne($, st, type);
		st.pending.set(type, p);
		void p.then(() => {
			st.pending.delete(type);
			st.stuck.delete(type);
		});
	}
	const waiting = [...st.pending].filter(([type]) => !st.stuck.has(type));
	if (waiting.length === 0) return;
	let timer;
	try {
		const late = await Promise.race([Promise.all(waiting.map(([, p]) => p)).then(() => false), new Promise((resolve) => {
			timer = $.clock.after(ms, () => resolve(true));
		})]);
		if (late) {
			for (const [type] of waiting) if (st.pending.has(type)) st.stuck.add(type);
		}
	} finally {
		timer?.cancel();
	}
}
