// Pure session-file integrity check. Returns an array of warning strings;
// callers decide how to surface them (debug log, piUI, diagDump, etc.).
// Extracted from index.ts so tests can import without activating the extension.

import { statSync, readFileSync } from "fs";

export function verifyWrittenSession(jsonlPath: string, expectedSessionId: string, expectedRecordCount: number): string[] {
	const warnings = [];
	let st;
	try {
		st = statSync(jsonlPath);
	} catch (e) {
		warnings.push(`file missing after save — path=${jsonlPath} err=${e.message}`);
		return warnings;
	}
	let content;
	try {
		content = readFileSync(jsonlPath, "utf8");
	} catch (e) {
		warnings.push(`file unreadable — path=${jsonlPath} size=${st.size} err=${e.message}`);
		return warnings;
	}
	const lines = content.split("\n").filter((l) => l.trim().length > 0);
	if (lines.length !== expectedRecordCount) {
		warnings.push(`record count mismatch — expected=${expectedRecordCount} actual=${lines.length} path=${jsonlPath} bytes=${content.length}`);
		return warnings;
	}
	let records;
	try {
		records = lines.map((l) => JSON.parse(l));
		const firstRec = records[0];
		const lastRec = records[records.length - 1];
		if (firstRec.sessionId !== expectedSessionId || lastRec.sessionId !== expectedSessionId) {
			warnings.push(`sessionId drift — expected=${expectedSessionId} first=${firstRec.sessionId} last=${lastRec.sessionId}`);
		}
	} catch (e) {
		warnings.push(`malformed JSONL — path=${jsonlPath} err=${e.message}`);
		return warnings;
	}
	const chainBreak = findParentChainBreak(records);
	if (chainBreak) warnings.push(`${chainBreak} — path=${jsonlPath}`);
	return warnings;
}

/**
 * Walk `parentUuid` from the last conversation record back to a root.
 *
 * Claude Code resumes a session by following this chain from the leaf, not by
 * reading the file top to bottom: a record naming a parent that no record
 * defines truncates the conversation there, and everything earlier in the file
 * is silently dropped from the replayed context. That is how a post-compaction
 * rebuild can hand CC a file whose very first record is the compaction summary
 * and still leave the model with no context at all.
 *
 * Returns a description of the break, or null when the chain reaches a record
 * with no parent. Records carrying no `uuid` (`last-prompt`, `mode`,
 * `atis-latch`, `queue-operation` — CC's own bookkeeping) sit outside the
 * conversation graph and are skipped. That allowlist is an assumption about
 * CC, so it is pinned against the installed CLI by the "every CC transcript
 * record in the conversation graph carries a uuid" case in
 * tests/int-cc-contracts.mjs — a new bookkeeping type fails there first.
 */
export function findParentChainBreak(records: Array<Record<string, any>>): string | null {
	const byUuid = new Map<string, number>();
	for (let i = 0; i < records.length; i++) {
		const uuid = records[i]?.uuid;
		if (typeof uuid === "string") byUuid.set(uuid, i);
	}
	let idx = -1;
	for (let i = records.length - 1; i >= 0; i--) {
		if (typeof records[i]?.uuid === "string") { idx = i; break; }
	}
	if (idx < 0) return null; // no conversation records at all — nothing to chain
	const seen = new Set<number>();
	let reached = idx;
	let length = 0;
	while (idx >= 0) {
		if (seen.has(idx)) return `parent-uuid cycle at record ${idx} (uuid=${records[idx].uuid})`;
		seen.add(idx);
		length++;
		if (idx < reached) reached = idx;
		const parent = records[idx].parentUuid;
		if (parent == null) return null; // reached a root
		const next = byUuid.get(parent);
		if (next === undefined) {
			return (
				`parent-uuid chain break at record ${idx} (type=${records[idx].type}, uuid=${records[idx].uuid}) ` +
				`names missing parent ${parent} — Claude Code would replay only ${length} of ${records.length} records, ` +
				`dropping everything before index ${reached}`
			);
		}
		idx = next;
	}
	return null;
}
