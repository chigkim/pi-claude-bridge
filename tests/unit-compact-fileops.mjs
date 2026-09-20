#!/usr/bin/env node

/**
 * The prior-compaction file-op carry-forward must stay bounded.
 *
 * Each compaction entry records the files it was handed *plus* everything the
 * previous compaction knew, so re-injecting the whole list unions a union: it
 * can only grow. A real session climbed 62 -> 99 modified paths over 15
 * compactions with no ceiling in sight, quietly inflating every summary prompt
 * from then on. These pin the cap and the newest-first eviction order.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { __test } = await import("../src/index.js");
const { reinjectPriorCompactionFileOps: reinject, MAX_REINJECTED_FILE_OPS: CAP } = __test;

const paths = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}${i}.ts`);

function prep(read = [], edited = []) {
	return { fileOps: { read: new Set(read), edited: new Set(edited) } };
}

function entries(readFiles, modifiedFiles) {
	return [
		{ type: "user" },
		{ type: "compaction", details: { readFiles: ["stale.ts"], modifiedFiles: ["stale.ts"] } },
		{ type: "compaction", details: { readFiles, modifiedFiles } },
	];
}

describe("reinjectPriorCompactionFileOps", () => {
	it("carries a short prior list forward whole", () => {
		const p = prep(["now.ts"]);
		reinject(entries(["a.ts", "b.ts"], ["c.ts"]), p);
		assert.deepEqual([...p.fileOps.read].sort(), ["a.ts", "b.ts", "now.ts"]);
		assert.deepEqual([...p.fileOps.edited], ["c.ts"]);
	});

	it("caps an oversized prior list instead of growing without bound", () => {
		const p = prep();
		reinject(entries(paths("r", CAP * 3), paths("m", CAP * 3)), p);
		assert.equal(p.fileOps.read.size, CAP);
		assert.equal(p.fileOps.edited.size, CAP);
	});

	it("keeps the newest prior paths and drops the oldest", () => {
		const p = prep();
		reinject(entries(paths("r", CAP + 10), []), p);
		// paths() is oldest-first, so the last CAP entries are the survivors.
		assert.ok(p.fileOps.read.has(`r${CAP + 9}.ts`), "newest kept");
		assert.ok(!p.fileOps.read.has("r0.ts"), "oldest dropped");
	});

	it("never evicts paths from the current turn", () => {
		const mine = paths("mine", 5);
		const p = prep(mine);
		reinject(entries(paths("r", CAP * 2), []), p);
		assert.equal(p.fileOps.read.size, CAP);
		for (const f of mine) assert.ok(p.fileOps.read.has(f), `${f} survived`);
	});

	it("reads the most recent compaction entry, not the first", () => {
		const p = prep();
		reinject(entries(["recent.ts"], []), p);
		assert.ok(p.fileOps.read.has("recent.ts"));
		assert.ok(!p.fileOps.read.has("stale.ts"));
	});

	it("ignores a prior entry whose details are missing or malformed", () => {
		for (const details of [undefined, {}, { readFiles: "nope", modifiedFiles: [] }]) {
			const p = prep(["now.ts"]);
			reinject([{ type: "compaction", details }], p);
			assert.deepEqual([...p.fileOps.read], ["now.ts"]);
		}
	});

	it("is a no-op when no compaction has happened yet", () => {
		const p = prep(["now.ts"]);
		reinject([{ type: "user" }, { type: "assistant" }], p);
		assert.deepEqual([...p.fileOps.read], ["now.ts"]);
	});
});
