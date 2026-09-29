#!/usr/bin/env node

/**
 * File lists carried across bridge compactions.
 *
 * pi drops a previous compaction's file lists when an extension wrote it, so the
 * bridge carries them itself. The first version trusted the previous entry's lists
 * for recency, but pi sorts them alphabetically: trimming "newest-first" kept the
 * paths that sort last, forever. One real session carried the same 102 of 132 paths
 * for a week, 84 to deleted files, with one file under four spellings. These pin
 * recency from the branch itself, one entry per file, and no deleted files.
 *
 * Every case runs against real files in a temp directory, so the filesystem rules
 * under test (case sensitivity, separators, symlinks) are the platform's own.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const { carryForwardFileOps: carry, resolveToolPath, MAX_CARRIED_FILE_OPS: CAP } = await import("../src/compaction-file-ops.js");

let root;
let seq = 0;
const win = process.platform === "win32";

before(() => {
	// realpath so macOS's /var -> /private/var symlink doesn't make expectations differ.
	root = realpathSync.native(mkdtempSync(join(tmpdir(), "bridge-fileops-")));
	mkdirSync(join(root, "src"));
});
after(() => rmSync(root, { recursive: true, force: true }));

/** Create files under root/src and return their absolute paths. */
function files(...names) {
	return names.map((name) => {
		const path = join(root, "src", name);
		writeFileSync(path, "");
		return path;
	});
}

const call = (name, path) => ({ type: "toolCall", id: `t${seq}`, name, arguments: { path } });
const assistant = (...calls) => ({ type: "message", id: `e${++seq}`, message: { role: "assistant", content: calls } });
const read = (path) => assistant(call("read", path));
const edit = (path) => assistant(call("edit", path));
const compaction = (readFiles, modifiedFiles) => ({ type: "compaction", id: `e${++seq}`, details: { readFiles, modifiedFiles } });

function prep(current = {}, firstKeptEntryId) {
	return { firstKeptEntryId, fileOps: { read: new Set(current.read ?? []), edited: new Set(current.edited ?? []), written: new Set(current.written ?? []) } };
}

/** pi's computeFileLists, so assertions see what the summary would list. */
function lists(p) {
	const modified = new Set([...p.fileOps.edited, ...p.fileOps.written]);
	return { read: [...p.fileOps.read].filter((f) => !modified.has(f)).sort(), modified: [...modified].sort() };
}

describe("carryForwardFileOps", () => {
	it("carries earlier files forward and classifies them as the tools did", () => {
		const [a, b] = files("carry-a.ts", "carry-b.ts");
		const p = prep();
		carry([read(a), edit(b)], p, root);
		assert.deepEqual(lists(p), { read: [a], modified: [b] });
	});

	it("keeps the most recently touched files, not the alphabetically last", () => {
		// Names sort in the opposite order to when they were touched.
		const names = Array.from({ length: CAP + 10 }, (_, i) => `rank-${String(CAP + 10 - i).padStart(3, "0")}.ts`);
		const paths = files(...names);
		const p = prep();
		const stats = carry(paths.map(read), p, root);
		assert.equal(stats.read, CAP);
		assert.ok(p.fileOps.read.has(paths.at(-1)), "newest kept");
		assert.ok(!p.fileOps.read.has(paths[0]), "oldest dropped");
	});

	it("ranks a file by its last touch, so reusing an old file keeps it", () => {
		const paths = files(...Array.from({ length: CAP + 5 }, (_, i) => `retouch-${i}.ts`));
		const p = prep();
		carry([...paths.map(read), read(paths[0])], p, root);
		assert.ok(p.fileOps.read.has(paths[0]));
		assert.ok(!p.fileOps.read.has(paths[1]));
	});

	it("does not let the previous compaction's sorted lists decide recency", () => {
		const paths = files(...Array.from({ length: CAP + 5 }, (_, i) => `sorted-${String(i).padStart(3, "0")}.ts`));
		const newest = paths[0];
		const p = prep();
		carry([compaction(paths.slice(1), []), read(newest)], p, root);
		assert.ok(p.fileOps.read.has(newest), "file touched after the compaction survives");
	});

	it("uses the previous compaction's lists for files no tool call explains, after everything else", () => {
		const [fromDetails, fromScan] = files("details-only.ts", "scanned.ts");
		const p = prep();
		carry([compaction([fromDetails], []), read(fromScan)], p, root);
		assert.deepEqual(lists(p).read, [fromDetails, fromScan].sort());

		const filler = files(...Array.from({ length: CAP }, (_, i) => `filler-${i}.ts`));
		const q = prep();
		carry([compaction([fromDetails], []), ...filler.map(read)], q, root);
		assert.ok(!q.fileOps.read.has(fromDetails), "ranked below every scanned file");
	});

	it("counts files from abandoned branches, as of when they were left", () => {
		const [a, b] = files("branch-read.ts", "branch-edit.ts");
		const p = prep();
		carry([{ type: "branch_summary", id: "bs", details: { readFiles: [a], modifiedFiles: [b] } }], p, root);
		assert.deepEqual(lists(p), { read: [a], modified: [b] });
	});

	it("drops earlier files that no longer exist", () => {
		const [kept] = files("still-here.ts");
		const gone = join(root, "src", "deleted.ts");
		const p = prep();
		const stats = carry([edit(gone), compaction([join(root, "gone-too.ts")], []), read(kept)], p, root);
		assert.deepEqual(lists(p), { read: [kept], modified: [] });
		assert.equal(stats.missing, 2);
	});

	it("keeps files from the span being summarized even if they no longer exist", () => {
		const gone = join(root, "src", "span-deleted.ts");
		const p = prep({ edited: [gone] });
		carry([], p, root);
		assert.deepEqual(lists(p).modified, [gone]);
	});

	it("never evicts the span's own files, and they count toward the cap", () => {
		const mine = files(...Array.from({ length: 5 }, (_, i) => `mine-${i}.ts`));
		const earlier = files(...Array.from({ length: CAP * 2 }, (_, i) => `earlier-${i}.ts`));
		const p = prep({ read: mine });
		carry(earlier.map(read), p, root);
		assert.equal(p.fileOps.read.size, CAP);
		for (const f of mine) assert.ok(p.fileOps.read.has(f), `${f} survived`);
	});

	it("caps read and modified separately", () => {
		const r = files(...Array.from({ length: CAP + 3 }, (_, i) => `cap-r-${i}.ts`));
		const m = files(...Array.from({ length: CAP + 3 }, (_, i) => `cap-m-${i}.ts`));
		const p = prep();
		carry([...r.map(read), ...m.map(edit)], p, root);
		assert.equal(lists(p).read.length, CAP);
		assert.equal(lists(p).modified.length, CAP);
	});

	it("keeps that a file was modified earlier when the span only read it", () => {
		const [f] = files("edited-then-read.ts");
		const p = prep({ read: [f] });
		carry([edit(f)], p, root);
		assert.deepEqual(lists(p), { read: [], modified: [f] });
	});

	it("stops at the kept tail, which the summary does not cover", () => {
		const [before, kept] = files("before-cut.ts", "in-kept-tail.ts");
		const keptEntry = read(kept);
		const p = prep({}, keptEntry.id);
		carry([read(before), keptEntry], p, root);
		assert.deepEqual(lists(p).read, [before]);
	});

	it("merges relative, absolute and redundant spellings of one file", () => {
		const [f] = files("spelled.ts");
		const p = prep({ read: [join("src", ".", "spelled.ts")] });
		carry([edit(join(root, "src", "..", "src", "spelled.ts")), read("./src/spelled.ts"), read(`@src/spelled.ts`)], p, root);
		assert.deepEqual(lists(p), { read: [], modified: [f] });
	});

	it("merges spellings that differ only in case where the filesystem ignores case", (t) => {
		const [f] = files("CaseTest.ts");
		if (!existsSync(join(root, "src", "casetest.ts"))) return t.skip("case-sensitive filesystem");
		const p = prep({ read: [join(root, "src", "casetest.ts")] });
		carry([edit(join(root, "src", "CASETEST.TS"))], p, root);
		assert.deepEqual(lists(p), { read: [], modified: [join(root, "src", "casetest.ts")] }, "the span's spelling wins");
	});

	it("keeps files that differ only in case apart where the filesystem respects case", (t) => {
		const [upper] = files("Distinct.ts");
		if (existsSync(join(root, "src", "distinct.ts"))) return t.skip("case-insensitive filesystem");
		const [lower] = files("distinct.ts");
		const p = prep();
		carry([read(upper), read(lower)], p, root);
		assert.deepEqual(lists(p).read, [upper, lower].sort());
	});

	it("merges a symlink with its target", (t) => {
		const [target] = files("link-target.ts");
		const link = join(root, "src", "link.ts");
		try {
			symlinkSync(target, link, "file");
		} catch {
			return t.skip("no permission to create symlinks");
		}
		const p = prep();
		carry([read(link), read(target)], p, root);
		assert.deepEqual(lists(p).read, [target], "newest spelling wins");
	});

	it("merges separator and drive spellings on Windows", { skip: !win && "Windows only" }, () => {
		const [f] = files("win-sep.ts");
		const forward = f.replaceAll("\\", "/");
		const lowerDrive = f[0].toLowerCase() + f.slice(1);
		const msys = `/${f[0].toLowerCase()}${forward.slice(2)}`;
		const p = prep({ read: [forward] });
		carry([edit(lowerDrive), read(msys)], p, root);
		assert.deepEqual(lists(p), { read: [], modified: [f] });
	});

	it("ignores malformed entries and details", () => {
		const [f] = files("malformed.ts");
		for (const details of [undefined, {}, { readFiles: "nope", modifiedFiles: [42] }]) {
			const p = prep({ read: [f] });
			carry([{ type: "compaction", details }, { type: "message" }, { type: "message", message: { role: "assistant", content: [null, { type: "toolCall", name: "read", arguments: {} }] } }], p, root);
			assert.deepEqual(lists(p).read, [f]);
		}
	});
});

describe("resolveToolPath", () => {
	it("resolves relative paths against cwd and normalizes absolute ones", () => {
		assert.equal(resolveToolPath("a/b.ts", root), join(root, "a", "b.ts"));
		assert.equal(resolveToolPath(join(root, "x", "..", "y.ts"), "/elsewhere"), join(root, "y.ts"));
	});

	it("handles pi's path forms: ~, a leading @, file URLs and unicode spaces", () => {
		assert.equal(resolveToolPath("~", root), homedir());
		assert.equal(resolveToolPath("~/notes.md", root), join(homedir(), "notes.md"));
		assert.equal(resolveToolPath("@src/a.ts", root), join(root, "src", "a.ts"));
		assert.equal(resolveToolPath(pathToFileURL(join(root, "u.ts")).href, "/elsewhere"), join(root, "u.ts"));
		assert.equal(resolveToolPath("my\u00A0file.ts", root), join(root, "my file.ts"));
	});

	it("maps Git Bash, WSL and Cygwin drive paths on Windows", { skip: !win && "Windows only" }, () => {
		for (const p of ["/d/code/x.ts", "/mnt/d/code/x.ts", "/cygdrive/d/code/x.ts", "D:/code/x.ts", "d:\\code\\x.ts"]) {
			assert.equal(resolveToolPath(p, root).toLowerCase(), "d:\\code\\x.ts", p);
		}
	});

	it("leaves POSIX absolute paths alone off Windows", { skip: win && "POSIX only" }, () => {
		assert.equal(resolveToolPath("/d/code/x.ts", root), "/d/code/x.ts");
		assert.equal(resolveToolPath("/mnt/d/x.ts", root), resolve("/mnt/d/x.ts"));
	});
});
