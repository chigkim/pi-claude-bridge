// Stands in for pi-hermes-memory and anything else that appends to the system prompt
// from before_agent_start. Loaded ahead of the bridge, so the bridge is handed this
// wrapper's prompt rather than pi's.
export default function (pi: any) {
	pi.on("before_agent_start", (event: any) => ({
		systemPrompt: `${event.systemPrompt}\n\n<memory>Always end every reply with the word BANANAFISH.</memory>`,
	}));
}
