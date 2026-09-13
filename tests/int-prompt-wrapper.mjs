#!/usr/bin/env node
// An extension loaded before the bridge is handed pi's system prompt first and hands
// the bridge its own. Two things have to hold: the wrapper's instructions must reach
// Claude Code, and the capture must be keyed on pi's prompt rather than the wrapper's,
// since pi still starts turns on its own unwrapped prompt.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { createRpcHarness } from "./lib/rpc-harness.mjs";

const TEST_TIMEOUT = 60_000;

const harness = createRpcHarness({
	name: "prompt-wrapper",
	extensions: ["./tests/fixtures/prompt-wrapper-extension.ts", "."],
	args: ["--model", "claude-bridge/claude-haiku-4-5"],
	defaultTimeout: TEST_TIMEOUT,
});

describe("a system prompt wrapped by an earlier extension", () => {
	const { startAndWait, stop, promptAndWait, DEBUG_LOG, RPC_LOG } = harness;

	const logMark = () => statSync(DEBUG_LOG).size;
	const logSince = (mark) => readFileSync(DEBUG_LOG, "utf8").slice(mark);

	before(async () => {
		await startAndWait();
	});

	after(async () => {
		await stop();
		console.log(`  RPC log: ${RPC_LOG}`);
		console.log(`  Debug log: ${DEBUG_LOG}`);
	});

	it("carries the wrapper's instructions through to Claude Code", { timeout: TEST_TIMEOUT }, async () => {
		const mark = logMark();
		const text = await promptAndWait("What is 2 + 2?");

		// Keyed on the wrapper, the capture holds only pi's portable parts and the
		// wrapper's own bytes reach Claude Code as nothing at all.
		assert.match(text, /BANANAFISH/, "the wrapper's instruction never reached Claude Code");
		assert.doesNotMatch(logSince(mark), /prompt-capture: no /, "a turn failed to resolve its prompt");
	});
});
