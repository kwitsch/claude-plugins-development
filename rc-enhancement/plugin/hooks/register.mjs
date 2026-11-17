import { GATE_REASON, isBareQuestion } from "./lib.mjs";
export const register = (on) => {
	let gateTurnId;
	let gatePending = false;
	on("turn.start", async function onTurnStart(_$, e, next) {
		if (e.agentId === undefined) {
			gateTurnId = gatePending || e.text.includes(GATE_REASON) ? e.turnId : undefined;
			gatePending = false;
		}
		return next(e);
	});
	on("turn.complete", async function onTurnComplete($, e, next) {
		if (e.agentId === undefined && e.reason === "answer" && e.turnId !== gateTurnId && isBareQuestion(e.answer)) {
			gatePending = true;
			$.prompt.submit({ text: GATE_REASON }).catch(() => {
				gatePending = false;
			});
		}
		return next(e);
	});
};
