export const clip = (text, max) => text.length > max ? `${text.slice(0, max)}… [${text.length - max} more chars]` : text;
const TRANSCRIPT_ONLY = /^\s*<(bash-input|bash-stdout|bash-stderr|local-command-stdout|local-command-caveat|command-name|command-message|system-reminder|task-notification)>/;
const COMMAND_ROW = /^\s*<command-message>/;
function typedCommand(text) {
	const name = /<command-name>\s*([^<]*?)\s*<\/command-name>/.exec(text)?.[1];
	if (!name) return undefined;
	const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim();
	return args ? `${name} ${args}` : name;
}
export function splitTurn(messages) {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role !== "user" || m.text.trim() === "" || m.toolResults?.length) continue;
		if (COMMAND_ROW.test(m.text)) {
			const typed = typedCommand(m.text);
			if (typed) return {
				request: typed,
				command: true,
				steps: messages.slice(i + 1)
			};
			continue;
		}
		if (!TRANSCRIPT_ONLY.test(m.text)) return {
			request: m.text,
			steps: messages.slice(i + 1)
		};
	}
	return undefined;
}
export function toolCalls(steps) {
	return steps.flatMap((m) => m.role === "assistant" ? m.toolUses : []);
}
export function summarize(steps, limit = 8) {
	const out = [];
	for (const m of steps) {
		if (m.role !== "assistant") continue;
		if (m.text.trim()) out.push({ assistant: clip(m.text, 400) });
		for (const use of m.toolUses) {
			out.push({
				tool: use.tool,
				input: clip(JSON.stringify(use.input), 300),
				...use.text !== undefined ? { result: clip(use.text, 400) } : {},
				...use.isError ? { isError: true } : {}
			});
		}
	}
	return out.slice(-limit);
}
