#!/usr/bin/env node

/**
 * A `compaction.model` in settings.json must reach a bridge session's compaction.
 *
 * pi runs every extension's session_before_compact handler and keeps the last
 * result, and the bridge's takeover is the one that lands on a claude-bridge
 * model — so a compaction extension reading `compaction.model` (a cheap
 * summarizer) was overwritten every time, its call paid for and discarded, and
 * the Claude summary that replaced it recorded no usage at all. These pin that
 * the takeover honours the setting, records the usage, and leaves the Claude
 * path to what the setting cannot name.
 */

import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// getAgentDir() reads this at each call, so the handler finds this settings.json.
const agentDir = mkdtempSync(join(tmpdir(), "claude-bridge-test-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));
const settings = (value) => writeFileSync(join(agentDir, "settings.json"), JSON.stringify(value));
// A project's .pi/settings.json, read from the session's cwd before the agent dir's.
const projectDir = mkdtempSync(join(tmpdir(), "claude-bridge-test-project-"));
mkdirSync(join(projectDir, ".pi"));
process.on("exit", () => rmSync(projectDir, { recursive: true, force: true }));
const projectSettings = (value) => value === undefined
	? rmSync(join(projectDir, ".pi", "settings.json"), { force: true })
	: writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify(value));

const { default: activate, __test } = await import("../src/index.js");

const luna = { provider: "openai-codex", id: "gpt-6-luna", baseUrl: "https://chatgpt.com", maxTokens: 128000, reasoning: false };
const opus = { provider: "claude-bridge", id: "claude-opus-5-5", baseUrl: "claude-bridge", maxTokens: 64000 };
const usage = { input: 900, output: 40, cacheRead: 0, cacheWrite: 0, totalTokens: 940, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function context({ models = [luna, opus], stream } = {}) {
	const notes = [];
	return {
		notes,
		model: opus,
		cwd: projectDir,
		ui: { notify: (text, level) => notes.push([level, text]) },
		modelRegistry: {
			find: (provider, id) => models.find((m) => m.provider === provider && m.id === id),
			streamSimple: stream ?? ((model) => ({
				result: async () => ({ role: "assistant", content: [{ type: "text", text: `summary by ${model.id}` }], stopReason: "stop", usage }),
			})),
		},
	};
}

function compactEvent(signal = new AbortController().signal) {
	return {
		reason: "threshold",
		willRetry: false,
		branchEntries: [],
		customInstructions: undefined,
		signal,
		preparation: {
			firstKeptEntryId: "kept",
			messagesToSummarize: [{ role: "user", content: "hello", timestamp: 0 }],
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 1000,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
		},
	};
}

function handler() {
	const handlers = new Map();
	activate({ on: (event, fn) => handlers.set(event, fn), registerProvider: () => {}, registerTool: () => {} });
	return handlers.get("session_before_compact");
}

describe("compactionModel", () => {
	beforeEach(() => projectSettings(undefined));

	it("is nothing when settings name no compaction model", () => {
		settings({ defaultModel: "claude-opus-5" });
		assert.equal(__test.compactionModel(context()), undefined);
	});

	it("resolves the provider/modelId settings name", () => {
		settings({ compaction: { model: "openai-codex/gpt-6-luna" } });
		assert.deepEqual(__test.compactionModel(context()), { model: luna, thinkingLevel: undefined });
	});

	it("reads the project's .pi/settings.json first, key by key", () => {
		settings({ compaction: { model: "openai-codex/gpt-9", thinkingLevel: "high" } });
		projectSettings({ compaction: { model: "openai-codex/gpt-6-luna" } });
		assert.deepEqual(__test.compactionModel(context()), { model: luna, thinkingLevel: "high" });
	});

	it("warns on a thinking level that is not one, and runs at none", () => {
		settings({ compaction: { model: "openai-codex/gpt-6-luna", thinkingLevel: "hard" } });
		const ctx = context();
		assert.deepEqual(__test.compactionModel(ctx), { model: luna, thinkingLevel: undefined });
		assert.match(ctx.notes[0][1], /Invalid compaction.thinkingLevel: hard/);
	});

	it("warns and yields nothing for a model the registry does not know", () => {
		settings({ compaction: { model: "openai-codex/gpt-9" } });
		const ctx = context();
		assert.equal(__test.compactionModel(ctx), undefined);
		assert.match(ctx.notes[0][1], /gpt-9 is unavailable/);
	});

	it("leaves a bridge model to the takeover, which is its own compaction", () => {
		settings({ compaction: { model: "claude-bridge/claude-opus-5-5" } });
		assert.equal(__test.compactionModel(context()), undefined);
	});
});

describe("compaction on a bridge session", () => {
	it("runs on the configured model and keeps its usage", async () => {
		settings({ compaction: { model: "openai-codex/gpt-6-luna" } });
		const result = await handler()(compactEvent(), context());
		assert.match(result.compaction.summary, /^summary by gpt-6-luna/);
		assert.deepEqual(result.compaction.usage, usage, "the call is recorded, unlike the takeover's");
		assert.equal(result.compaction.firstKeptEntryId, "kept");
	});

	it("asks the configured model for compaction.thinkingLevel", async () => {
		settings({ compaction: { model: "openai-codex/gpt-6-luna", thinkingLevel: "medium" } });
		const asked = [];
		const reasoner = { ...luna, reasoning: true };
		const ctx = context({
			models: [reasoner, opus],
			stream: (model, _context, options) => {
				asked.push(options.reasoning);
				return { result: async () => ({ role: "assistant", content: [{ type: "text", text: "summary" }], stopReason: "stop", usage }) };
			},
		});
		await handler()(compactEvent(), ctx);
		assert.deepEqual(asked, ["medium"]);
	});

	it("cancels on abort rather than starting a second summary", async () => {
		settings({ compaction: { model: "openai-codex/gpt-6-luna" } });
		const aborting = new AbortController();
		const ctx = context({ stream: () => ({ result: async () => { aborting.abort(); throw new Error("aborted"); } }) });
		assert.deepEqual(await handler()(compactEvent(aborting.signal), ctx), { cancel: true });
	});

	it("leaves other providers' sessions to pi and the other extensions", async () => {
		settings({ compaction: { model: "openai-codex/gpt-6-luna" } });
		const ctx = { ...context(), model: luna };
		assert.equal(await handler()(compactEvent(), ctx), undefined);
	});
});
