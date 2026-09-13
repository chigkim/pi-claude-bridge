/**
 * Unit tests for discardRewrittenQuery — the compaction loop (issue #101).
 *
 * pi can rewrite its history (/compact, tree navigation) while a Claude Code
 * query sits parked at a tool boundary waiting for its result. The tool-result
 * path is the one provider call that never syncs the shared session, so
 * `needsRebuild` alone does not stop it: the result is routed into the parked
 * query, CC answers over the pre-compact conversation and reports its full
 * usage, and pi crosses the same threshold again at the next boundary. Observed
 * as eight compactions in eight minutes with cacheRead never dropping.
 *
 * What has to hold is that the parked query stops being a routing target the
 * moment its conversation is rewritten, and that it cannot reach back and
 * overwrite what replaced it.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { QueryContext } from "../src/query-state.js";

const { __test } = await import("../src/index.js");
const { discardRewrittenQuery, contextForToolResults, activeQueryContexts, isQueryAbandoned, markRebuild, getHistoryRewritten, resetSharedSession, setSharedSession, getSharedSession } = __test;

/** A query parked mid-turn: CC asked for a tool and is waiting on the answer. */
function parkedQuery(toolCallId = "call_1") {
	const events = [];
	const sdkQuery = {
		interrupt: () => { events.push("interrupt"); return Promise.resolve(); },
		close: () => { events.push("close"); },
	};
	const c = new QueryContext();
	c.activeQuery = sdkQuery;
	c.turnToolCallIds = [toolCallId];
	c.pendingToolCalls.set(toolCallId, {
		toolName: "read",
		resolve: (result) => { events.push(`resolve:${result.content[0].text}`); },
	});
	c.promptStream = { fail: (error) => { events.push(`fail:${error.message}`); } };
	activeQueryContexts.add(c);
	return { c, sdkQuery, events };
}

describe("markRebuild", () => {
	beforeEach(() => resetSharedSession());

	it("records the rewrite when no CC session exists yet", () => {
		// sharedSession is only assigned when a query completes, so it is null for
		// the whole of a first turn — and a first turn is long enough to compact.
		assert.equal(getSharedSession(), null, "precondition: nothing has completed yet");

		markRebuild("session_compact:threshold");

		assert.equal(getHistoryRewritten(), true,
			"dropped here, the parked query survives the compaction and pi compacts again at every boundary");
	});

	it("also forces the next call down the rebuild path once a session is known", () => {
		setSharedSession({ sessionId: "abc", cursor: 3, cwd: "/tmp", needsRebuild: false });

		markRebuild("session_tree");

		assert.equal(getHistoryRewritten(), true);
		assert.equal(getSharedSession().needsRebuild, true, "--resume would replay a history pi no longer has");
	});
});

describe("discardRewrittenQuery", () => {
	beforeEach(() => { activeQueryContexts.clear(); });

	it("stops the parked query being a routing target for the turn's result", () => {
		const { c } = parkedQuery();
		const results = [{ toolCallId: "call_1", content: [{ type: "text", text: "file contents" }] }];

		assert.equal(contextForToolResults(results), c, "precondition: the result routes to the parked query");

		discardRewrittenQuery(c);

		assert.equal(contextForToolResults(results), undefined,
			"a result routed into the discarded query would resume the pre-rewrite conversation");
		assert.equal(c.activeQuery, null);
		assert.equal(activeQueryContexts.has(c), false, "routing matches ids only against contexts in this set");
	});

	it("settles everything awaiting the subprocess before killing it", () => {
		const { c, events } = parkedQuery();

		discardRewrittenQuery(c);

		const released = events.findIndex((e) => e.startsWith("resolve:"));
		const killed = events.indexOf("interrupt");
		assert.ok(released !== -1, "a handler left awaiting a dead subprocess wedges pi's turn behind it");
		assert.ok(killed !== -1 && released < killed, "handlers must be released before the CLI is killed");
		assert.ok(events.includes("close"), "interrupt alone lets the current API call finish");
		assert.ok(events.some((e) => e.startsWith("fail:")), "the parked ack has nothing left to resume it");
		assert.equal(c.promptStream, null);
		assert.equal(c.pendingToolCalls.size, 0);
	});

	it("marks the query abandoned so its completion cannot overwrite the rebuild", () => {
		const { c, sdkQuery } = parkedQuery();

		assert.equal(isQueryAbandoned(sdkQuery), false);
		discardRewrittenQuery(c);
		assert.equal(isQueryAbandoned(sdkQuery), true,
			"its completion handler would otherwise capture the stale session id over the rebuilt one");
	});

	it("is safe on a context whose query already ended", () => {
		const c = new QueryContext();
		activeQueryContexts.add(c);

		discardRewrittenQuery(c);

		assert.equal(c.activeQuery, null);
		assert.equal(activeQueryContexts.has(c), false);
	});
});
