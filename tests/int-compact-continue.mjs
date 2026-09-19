#!/usr/bin/env node
// Regression: after a mid-turn auto-compaction, the continuation loses all context.
//
// The existing compaction tests all resume with a *fresh user prompt*, which is
// the easy case: the prompt carries the turn's intent and pi's post-compaction
// message list ends with a user message. The failing case in the field is the
// other one — auto-compaction fires at a tool boundary inside a running turn, so
// pi calls agent.continue() and the message list ends with a toolResult. The
// bridge then finds no user turn (`extractUserPrompt` returns null), trips the
// `empty_prompt` guard, and sends the literal string "[continue]" to Claude Code,
// relying entirely on the resumed CC session to carry the history.
//
// Observed in a real session (Marrow-Cross, 2026-09-18, six compactions): every
// post-compaction continuation opened with the model saying it had no prior
// context and starting over from the project's memory docs.
//
// Determinism: auto-compaction is off for the seed turns, then enabled from the
// first turn_end *inside* the second turn. That lands the threshold check in
// AgentSession._compactBeforeNextAssistantResponse (the prepareNextTurn path)
// rather than the pre-prompt _checkCompaction, which is what makes it a mid-turn
// compaction with a continuation instead of a fresh prompt.
//
// The codeword is seeded in turn A and never repeated, so after the cut it exists
// only inside the compaction summary. If the continuation can still name it, the
// summary reached Claude Code.
//
// Expected:
//   - RED (bug present): the final answer does not contain the codeword.
//   - GREEN: it does, and the debug log shows the continuation ran with the
//     "[continue]" fallback prompt (proving we exercised that path and not a
//     fresh-prompt compaction).

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRpcHarness } from "./lib/rpc-harness.mjs";
import { findParentChainBreak } from "../src/session-verify.js";

const BRIDGE_MODEL = "claude-bridge/claude-haiku-4-5";
const TEST_TIMEOUT = 240_000;
const CODEWORD = "ZEBRAFINCH-7731";

const testAgentDir = mkdtempSync(join(tmpdir(), "compact-continue-agent-"));
writeFileSync(join(testAgentDir, "settings.json"), JSON.stringify({
	compaction: { enabled: false, reserveTokens: 198000, keepRecentTokens: 50 },
}));

const harness = createRpcHarness({
	name: "compact-continue",
	args: ["--model", BRIDGE_MODEL],
	env: { PI_CODING_AGENT_DIR: testAgentDir },
	defaultTimeout: TEST_TIMEOUT,
});

const { startAndWait, stop, send, promptAndWait, waitForEvent, addListener, collectText, DEBUG_LOG, RPC_LOG } = harness;

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

await startAndWait();

try {
	console.log(`Seed turn A: plant the codeword (auto-compaction off)...`);
	const seedA = await promptAndWait(
		`The build codeword for this project is ${CODEWORD}. Reply with exactly "codeword-stored" and nothing else.`,
		TEST_TIMEOUT,
	);
	assert(/codeword-stored/i.test(seedA), `seed A did not confirm. Got: ${seedA.slice(0, 200)}`);

	console.log("Seed turn B: bulk filler so the cut point has something to remove...");
	const seedB = await promptAndWait(
		'Do not use tools. Reply with 120 numbered lines about European capital cities, one per line, nothing else.',
		TEST_TIMEOUT,
	);
	assert(seedB.length > 1000, `seed B too short to shift the threshold: ${seedB.length} chars`);

	// Enable auto-compaction only once the working turn is already running, so the
	// threshold check that fires is the between-turns one and pi continues rather
	// than re-prompts.
	const compactionStarts = [];
	const compactionEnds = [];
	let enablePromise;
	let disablePromise;
	addListener((msg) => {
		if (msg.type === "turn_end" && !enablePromise) {
			enablePromise = send({ type: "set_auto_compaction", enabled: true }, 30_000).catch(() => {});
		} else if (msg.type === "compaction_start") {
			compactionStarts.push(msg);
			if (!disablePromise) {
				disablePromise = send({ type: "set_auto_compaction", enabled: false }, 30_000).catch(() => {});
			}
		} else if (msg.type === "compaction_end") {
			compactionEnds.push(msg);
		}
	});

	console.log("Working turn: sequential tool calls, then recall the codeword...");
	const collector = collectText();
	await send({
		type: "prompt",
		message:
			"Do these steps one at a time, each in its own step, never in parallel:\n"
			+ "1. Use the read tool on tests/fixtures/compact-file-a.txt.\n"
			+ "2. Then use the read tool on tests/fixtures/compact-file-b.txt.\n"
			+ "3. Then use the read tool on tests/fixtures/compact-file-a.txt again.\n"
			+ "4. Then reply with the build codeword stated earlier in this conversation, on a line "
			+ "of its own. If it is not present anywhere in your context, reply CODEWORD-LOST instead.",
	}, TEST_TIMEOUT);
	await waitForEvent("agent_end", TEST_TIMEOUT);
	const answer = collector.stop();
	if (enablePromise) await enablePromise;
	if (disablePromise) await disablePromise;

	const debugLog = readFileSync(DEBUG_LOG, "utf8");

	// Precondition: we actually exercised mid-turn compaction + continuation.
	assert(
		compactionEnds.length > 0,
		`no compaction fired during the working turn — the threshold never tripped, so this run proves nothing. `
		+ `starts=${compactionStarts.length}`,
	);
	assert(
		/prompt=\[continue\]/.test(debugLog),
		"compaction fired but the bridge never used the [continue] fallback, so this run exercised the "
		+ "fresh-prompt path, not the continuation path",
	);

	// Precondition: the summary is where the codeword lives now.
	const summary = compactionEnds[0]?.result?.summary ?? "";
	assert(summary.trim(), `compaction returned an empty summary: ${JSON.stringify(compactionEnds[0])}`);
	assert(
		summary.includes(CODEWORD),
		`INCONCLUSIVE: the summarizer dropped the codeword, so the continuation could not recall it either way. `
		+ `Summary head: ${summary.slice(0, 400)}`,
	);

	// The actual assertion.
	assert(
		answer.includes(CODEWORD),
		`post-compaction continuation lost its context: the answer does not contain the codeword that the `
		+ `compaction summary carries. Answer: ${answer.slice(0, 400)}`,
	);
	assert(
		!/CODEWORD-LOST/.test(answer),
		`post-compaction continuation reported CODEWORD-LOST. Answer: ${answer.slice(0, 400)}`,
	);

	// Structural assertion, independent of what the model happened to recall.
	//
	// Claude Code replays only the records its parentUuid chain reaches walking
	// back from the leaf. Compaction at a tool boundary interrupts the parked CC
	// query, and the interrupted subprocess flushes a late "[Request interrupted
	// by user]" record carrying a parent from the conversation pi just replaced.
	// Rebuilding in place under the same session id drops that record into the
	// freshly written file naming a parent no record defines — so the compaction
	// summary sits at record [0] and still never reaches the API. The codeword
	// check above can pass by luck (the model guessing, or a fresh-prompt path);
	// this one cannot.
	//
	// Only the *live* session is asserted on. The fix works by rotating to a
	// fresh session id and leaving the previous file behind precisely so the
	// orphaned subprocess can finish writing its dangling record somewhere
	// harmless — so an abandoned file with a broken chain is the fix working,
	// not failing. Each rebuild logs its path, so the last one logged is the
	// session that served the final answer.
	const sessionPaths = [...debugLog.matchAll(/jsonlPath=(.+\.jsonl)$/gm)].map((m) => m[1].trim());
	assert(sessionPaths.length > 0, "debug log names no session jsonlPath, so the chain cannot be checked");
	const livePath = sessionPaths[sessionPaths.length - 1];

	// Precondition for this test proving anything: compaction must actually have
	// interrupted a parked query and rotated the session. Without that there is
	// no orphan writer, so an intact chain below is the easy case passing, not
	// the fix working. Assert it from the log rather than inferring it from the
	// paths — only rebuilds log a jsonlPath, so the rotated-away session usually
	// has no line of its own.
	assert(
		/history rewritten under a parked query/.test(debugLog),
		"compaction never interrupted a parked query, so no orphaned CC writer existed and this run "
		+ "does not exercise the rotation fix",
	);
	const rotation = /new session ([0-9a-f-]+) \(was ([0-9a-f-]+), rotated to avoid race with orphan writer\)/.exec(debugLog);
	assert(
		rotation,
		"the parked query was discarded but the session was NOT rotated — the rebuild reused the id in "
		+ "place, which is exactly the defect: the orphan's late record lands in the fresh file naming a "
		+ "parent no record defines",
	);
	const [, rotatedTo, rotatedFrom] = rotation;
	assert(
		livePath.includes(rotatedTo),
		`the live session (${livePath}) is not the one rotation produced (${rotatedTo})`,
	);
	// The debug log names sessions by their 8-char prefix, so resolve the rotated
	// -away file by prefix rather than assuming the id is complete.
	const sessionDir = dirname(livePath);
	const abandonedPath = readdirSync(sessionDir)
		.filter((f) => f.startsWith(rotatedFrom) && f.endsWith(".jsonl"))
		.map((f) => join(sessionDir, f))[0];

	let liveRecords;
	try {
		liveRecords = readFileSync(livePath, "utf8").trim().split("\n")
			.filter((l) => l.trim()).map((l) => JSON.parse(l));
	} catch (e) {
		throw new Error(`live session file is unreadable: ${livePath} (${e.message})`);
	}
	assert(liveRecords.length > 0, `live session file is empty: ${livePath}`);
	const chainBreak = findParentChainBreak(liveRecords);
	assert(
		!chainBreak,
		`the session Claude Code resumed has a broken parent chain, so it replayed only part of it: `
		+ `${chainBreak} (${livePath})`,
	);

	// Informational: where the orphan's late record actually landed. A break here
	// is the fix working — that file is the one nobody resumes.
	let abandonedNote = abandonedPath ? "unreadable" : "no file under that id";
	if (abandonedPath) {
		try {
			const recs = readFileSync(abandonedPath, "utf8").trim().split("\n")
				.filter((l) => l.trim()).map((l) => JSON.parse(l));
			abandonedNote = `${recs.length} records, chain ${findParentChainBreak(recs) ? "broken (expected — the orphan wrote here, where nobody resumes)" : "intact (orphan never flushed)"}`;
		} catch { /* cleaned up mid-read */ }
	}

	console.log(`  compactions:  ${compactionEnds.length}`);
	console.log(`  summary head: ${summary.slice(0, 80).replace(/\n/g, " ")}...`);
	console.log(`  rotated:      ${rotatedFrom.slice(0, 8)} → ${rotatedTo.slice(0, 8)}`);
	console.log(`  live chain:   intact, ${liveRecords.length} records (${livePath})`);
	console.log(`  abandoned:    ${rotatedFrom.slice(0, 8)} — ${abandonedNote}`);
	console.log("PASS");
} catch (e) {
	process.exitCode = 1;
	console.log(`FAIL: ${e.message}\n${e.stack}`);
	console.log(`  RPC log:    ${RPC_LOG}`);
	console.log(`  Debug log:  ${DEBUG_LOG}`);
	try { console.log(`  Debug tail: ${readFileSync(DEBUG_LOG, "utf8").slice(-4000)}`); } catch {}
} finally {
	await stop();
	rmSync(testAgentDir, { recursive: true, force: true });
}
