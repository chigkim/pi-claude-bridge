import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { basePromptKey, reconstructBasePrompt } from "../src/base-prompt.js";
import { PromptCaptures, projectPromptCapture } from "../src/prompt-capture.js";

const OPTIONS = {
	cwd: "/project",
	selectedTools: ["read", "bash"],
	toolSnippets: { read: "read a file", bash: "run a command" },
	promptGuidelines: ["be brief"],
	contextFiles: [{ path: "/project/AGENTS.md", content: "project rules" }],
	skills: [],
	appendSystemPrompt: "appended by the user",
};

// The whole fix rests on reproducing what pi assembled from the options pi handed us,
// which means reaching a module pi does not export. Pin it against the installed pi:
// if this fails, basePromptKey has silently fallen back and wrapper text is being lost.
describe("base prompt reconstruction", () => {
	it("reproduces pi's own prompt from the options pi reports", async () => {
		const base = await reconstructBasePrompt(OPTIONS);
		assert.ok(base, "pi's buildSystemPrompt was not reachable");
		assert.match(base, /project rules/);
		assert.match(base, /appended by the user/);
	});

	it("keys on pi's prompt, not on the wrapper an earlier extension handed us", async () => {
		const base = await reconstructBasePrompt(OPTIONS);
		const wrapped = `${base}\n\n<memory>remembered facts</memory>`;

		assert.equal(await basePromptKey(wrapped, OPTIONS), base);
		assert.equal(await basePromptKey(base, OPTIONS), base, "an unwrapped prompt keys on itself");
	});

	it("keeps the wrapper's own text reaching Claude Code", async () => {
		const base = await reconstructBasePrompt(OPTIONS);
		const wrapped = `${base}\n\n<memory>remembered facts</memory>`;
		const captures = new PromptCaptures();
		captures.record(await basePromptKey(wrapped, OPTIONS), {
			contextFiles: OPTIONS.contextFiles,
			skills: [],
			append: OPTIONS.appendSystemPrompt,
		});

		// The turn pi runs on its own base prompt: the one that used to fail.
		assert.ok(captures.resolveOrDerive(base), "pi's own prompt must resolve");

		const projected = projectPromptCapture(captures.resolveOrDerive(wrapped), { skillReadTool: "mcp" });
		assert.match(projected, /remembered facts/, "the wrapper's instructions must survive");
		assert.match(projected, /project rules/);
		assert.match(projected, /appended by the user/);
	});

	it("falls back to the handed-down prompt when an extension rebuilt rather than wrapped", async () => {
		const rebuilt = "an extension replaced the prompt wholesale";
		assert.equal(await basePromptKey(rebuilt, OPTIONS), rebuilt);
	});

	it("falls back when pi reported no options", async () => {
		assert.equal(await basePromptKey("prompt", undefined), "prompt");
	});
});
