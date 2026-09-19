/**
 * Tests for session integrity helpers:
 *   - repairToolPairing (from cc-session-io): pairs orphan tool_use blocks
 *     with synthetic tool_result so imported history never starts mid-turn.
 *   - verifyWrittenSession (from session-verify.js): warns if the JSONL file
 *     doesn't round-trip (missing file, record-count mismatch, sessionId drift).
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repairToolPairing } from "cc-session-io";
import { findParentChainBreak, verifyWrittenSession } from "../src/session-verify.js";

// --- repairToolPairing ---

describe("repairToolPairing", () => {
	it("passes through a paired tool_use/tool_result", () => {
		const msgs = [
			{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "X", input: {} }] },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
		];
		const repaired = repairToolPairing(msgs);
		assert.equal(repaired.length, msgs.length);
	});

	it("synthesizes a tool_result for an orphan tool_use", () => {
		const msgs = [
			{ role: "assistant", content: [{ type: "tool_use", id: "orphan", name: "X", input: {} }] },
			{ role: "user", content: "next turn" },
		];
		const repaired = repairToolPairing(msgs);
		// Prepends a synthetic tool_result block to the next user message (in-place, same count).
		assert.equal(repaired.length, msgs.length);
		const nextUser = repaired[1];
		assert.equal(nextUser.role, "user");
		assert.ok(Array.isArray(nextUser.content));
		assert.equal(nextUser.content[0].type, "tool_result");
		assert.equal(nextUser.content[0].tool_use_id, "orphan");
		assert.equal(nextUser.content[0].is_error, true);
	});

	it("empty input returns empty", () => {
		assert.deepEqual(repairToolPairing([]), []);
	});
});

describe("verifyWrittenSession", () => {
	const dir = mkdtempSync(join(tmpdir(), "verify-session-"));
	const path = join(dir, "session.jsonl");
	const SID = "abc-123";
	const rec = (sessionId, i) => JSON.stringify({ sessionId, idx: i });
	after(() => rmSync(dir, { recursive: true, force: true }));

	it("no warnings when file round-trips correctly", () => {
		writeFileSync(path, [rec(SID, 0), rec(SID, 1), rec(SID, 2)].join("\n") + "\n");
		assert.deepEqual(verifyWrittenSession(path, SID, 3), []);
	});

	it("warns when file is missing", () => {
		const missing = join(dir, "nope.jsonl");
		const warnings = verifyWrittenSession(missing, SID, 0);
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /file missing/);
	});

	it("warns on record count mismatch", () => {
		writeFileSync(path, [rec(SID, 0), rec(SID, 1)].join("\n") + "\n");
		const warnings = verifyWrittenSession(path, SID, 5);
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /record count mismatch.*expected=5.*actual=2/);
	});

	it("warns on sessionId drift", () => {
		writeFileSync(path, [rec(SID, 0), rec("different-sid", 1)].join("\n") + "\n");
		const warnings = verifyWrittenSession(path, SID, 2);
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /sessionId drift/);
	});

	it("warns on malformed JSONL", () => {
		writeFileSync(path, "not json\n");
		const warnings = verifyWrittenSession(path, SID, 1);
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /malformed JSONL/);
	});
});

// --- findParentChainBreak ---
//
// Claude Code resumes a session by walking parentUuid back from the leaf, not by
// reading the file top to bottom. A record naming a parent no record defines
// truncates the replay there, and everything earlier in the file is dropped with
// nothing in the stream to say so. That is how a post-compaction rebuild handed
// CC a file whose record [0] was the compaction summary and still left the model
// reporting no context at all: an orphaned CC subprocess, interrupted by
// discardRewrittenQuery, flushed its "[Request interrupted by user]" record into
// the recreated file carrying a parent uuid from the deleted generation.

describe("findParentChainBreak", () => {
	const dir = mkdtempSync(join(tmpdir(), "chain-break-"));
	const path = join(dir, "session.jsonl");
	const SID = "chain-sid";
	after(() => rmSync(dir, { recursive: true, force: true }));

	const chain = (...links) =>
		links.map(([uuid, parentUuid], i) => ({ type: i % 2 ? "user" : "assistant", uuid, parentUuid }));

	it("returns null for a chain that reaches a root", () => {
		assert.equal(findParentChainBreak(chain(["a", null], ["b", "a"], ["c", "b"])), null);
	});

	it("returns null when there are no conversation records", () => {
		assert.equal(findParentChainBreak([{ type: "last-prompt" }, { type: "atis-latch" }]), null);
	});

	it("returns null for an empty file", () => {
		assert.equal(findParentChainBreak([]), null);
	});

	it("ignores uuid-less bookkeeping records interleaved in the chain", () => {
		const records = [
			{ type: "assistant", uuid: "a", parentUuid: null },
			{ type: "mode" },
			{ type: "user", uuid: "b", parentUuid: "a" },
			{ type: "atis-latch" },
		];
		assert.equal(findParentChainBreak(records), null);
	});

	it("detects a dangling parent and reports how much CC would drop", () => {
		// [0..1] are reachable only from each other; [2] grafts onto a uuid from a
		// deleted session generation, so walking back from the leaf stops at [2].
		const records = chain(["summary", null], ["kept", "summary"], ["orphan", "gone"], ["live", "orphan"]);
		const found = findParentChainBreak(records);
		assert.match(found, /chain break at record 2/);
		assert.match(found, /missing parent gone/);
		assert.match(found, /replay only 2 of 4 records/);
		assert.match(found, /dropping everything before index 2/);
	});

	it("detects a parent-uuid cycle instead of looping forever", () => {
		const records = chain(["a", "b"], ["b", "a"]);
		assert.match(findParentChainBreak(records), /cycle/);
	});

	it("verifyWrittenSession surfaces a chain break", () => {
		const records = [
			{ sessionId: SID, type: "user", uuid: "root", parentUuid: null },
			{ sessionId: SID, type: "user", uuid: "orphan", parentUuid: "missing" },
		];
		writeFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
		const warnings = verifyWrittenSession(path, SID, 2);
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /parent-uuid chain break/);
	});
});
