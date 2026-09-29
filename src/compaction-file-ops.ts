// Carry the read/modified file lists across compactions the bridge performs.
//
// pi only carries a previous compaction's file lists forward when pi itself wrote
// that compaction (`!fromHook`). Every compaction on a bridge model comes from our
// `session_before_compact` takeover, so without this each summary would forget
// every file touched before the last one.
//
// The previous compaction's `details` lists can't say which files are recent: pi
// sorts them alphabetically, and each one already holds the union of all the lists
// before it. Trimming them "newest-first" therefore trimmed alphabetically, and the
// paths that sort last never left. One session carried the same 102 of 132 paths
// through every compaction for a week, 84 of them to files that no longer existed,
// and some files under up to four spellings (`D:/x`, `D:\x`, `x`, ...).
//
// So recency comes from the session itself. The branch still holds every tool call
// since the session began, so we rank each file by when it was last touched, merge
// every spelling of one file into one entry, and drop files that no longer exist.
// The previous compaction's lists are used only for files the scan can't see.

import { statSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Cap on how many earlier file paths each list (read, modified) carries into the next
 *  summary. Paths touched in the span being summarized always stay and count toward it. */
export const MAX_CARRIED_FILE_OPS = 64;

export interface FileOpSets {
	read: Set<string>;
	edited: Set<string>;
	written?: Set<string>;
}

interface BranchEntry {
	type: string;
	id?: string;
	message?: unknown;
	details?: unknown;
}

export interface CarryForwardStats {
	/** Earlier paths added to the read list. */
	read: number;
	/** Earlier paths added to the modified list. */
	modified: number;
	/** Distinct earlier files considered. */
	candidates: number;
	/** Earlier files skipped because they no longer exist. */
	missing: number;
}

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/** Resolve a tool-call path the way pi's read/edit/write tools do (`resolveToCwd`), so
 *  every spelling of one file becomes the same absolute, platform-native string. */
export function resolveToolPath(input: string, cwd: string): string {
	let p = input.replace(UNICODE_SPACES, " ");
	if (p.startsWith("@")) p = p.slice(1);
	if (process.platform === "win32") p = windowsShellPathToNative(p);
	if (p === "~") return homedir();
	if (p.startsWith("~/") || (process.platform === "win32" && p.startsWith("~\\"))) return resolve(join(homedir(), p.slice(2)));
	if (p.startsWith("file://")) {
		try {
			p = fileURLToPath(p);
		} catch {}
	}
	return isAbsolute(p) ? resolve(p) : resolve(cwd, p);
}

/** Git Bash, MSYS, Cygwin and WSL drive paths (`/d/x`, `/mnt/d/x`, `/cygdrive/d/x`) to `D:\x`. */
function windowsShellPathToNative(p: string): string {
	if (!p.startsWith("/") || p.startsWith("//") || p.includes("\\")) return p;
	const match = p.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
	if (!match) return p;
	return `${match[1].toUpperCase()}:\\${match[2]?.replaceAll("/", "\\") ?? ""}`;
}

/** One key per file on disk, however it is spelled: case variants on case-insensitive
 *  volumes (Windows, default macOS), symlinks and hard links all share an inode. Returns
 *  undefined for a path that no longer exists. */
function fileIdentity(absolute: string): string | undefined {
	try {
		const stats = statSync(absolute, { bigint: true });
		// Some filesystems report no inode number (0); the canonical path still names the file.
		return stats.ino ? `${stats.dev}:${stats.ino}` : realpathSync.native(absolute);
	} catch {
		return undefined;
	}
}

/** Key for a path in the span being summarized, which is kept whether or not it exists. */
function pathKey(absolute: string): string {
	return fileIdentity(absolute) ?? (process.platform === "win32" ? absolute.toLowerCase() : absolute);
}

/** pi's `extractFileOpsFromMessage`: file tool calls in one assistant message. */
function forEachFileOp(message: unknown, visit: (path: string, modified: boolean) => void): void {
	const msg = message as { role?: string; content?: unknown };
	if (msg?.role !== "assistant" || !Array.isArray(msg.content)) return;
	for (const block of msg.content as Array<{ type?: string; name?: string; arguments?: { path?: unknown } }>) {
		if (block?.type !== "toolCall" || typeof block.arguments?.path !== "string") continue;
		if (block.name === "read") visit(block.arguments.path, false);
		else if (block.name === "edit" || block.name === "write") visit(block.arguments.path, true);
	}
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** Normalize the span's own file sets in place, merging spellings of the same file.
 *  Returns the key of every file they now hold, mapped to the string used for it. */
function normalizeCurrent(fileOps: FileOpSets, cwd: string): Map<string, string> {
	const shown = new Map<string, string>();
	for (const set of [fileOps.edited, fileOps.written, fileOps.read]) {
		if (!set) continue;
		const raw = [...set];
		set.clear();
		for (const path of raw) {
			const absolute = resolveToolPath(path, cwd);
			const key = pathKey(absolute);
			if (!shown.has(key)) shown.set(key, absolute);
			set.add(shown.get(key)!);
		}
	}
	return shown;
}

/**
 * Add earlier files to the file sets pi is about to summarize from, most recently
 * touched first, up to MAX_CARRIED_FILE_OPS per list. Also rewrites the sets' own
 * paths to one absolute spelling per file, so the lists pi computes from them never
 * name one file twice. Mutates `preparation.fileOps`.
 */
export function carryForwardFileOps(
	branchEntries: readonly BranchEntry[],
	preparation: { firstKeptEntryId?: string; fileOps: FileOpSets },
	cwd: string,
): CarryForwardStats {
	const { fileOps } = preparation;
	const current = normalizeCurrent(fileOps, cwd);

	// Last touch of each resolved path before the kept tail. Map insertion order is
	// refreshed on every touch, so iterating it backwards gives newest first.
	const touched = new Map<string, { modified: boolean }>();
	const touch = (path: string, modified: boolean) => {
		const absolute = resolveToolPath(path, cwd);
		const prev = touched.get(absolute);
		touched.delete(absolute);
		touched.set(absolute, { modified: modified || !!prev?.modified });
	};
	let lastCompaction: BranchEntry | undefined;
	for (const entry of branchEntries) {
		if (entry.id !== undefined && entry.id === preparation.firstKeptEntryId) break;
		if (entry.type === "message") forEachFileOp(entry.message, touch);
		else if (entry.type === "compaction") lastCompaction = entry;
		else if (entry.type === "branch_summary") {
			// Files from an abandoned branch, as of when the user left it.
			const details = entry.details as { readFiles?: unknown; modifiedFiles?: unknown } | undefined;
			for (const path of stringArray(details?.readFiles)) touch(path, false);
			for (const path of stringArray(details?.modifiedFiles)) touch(path, true);
		}
	}
	const ranked = [...touched].reverse();

	// Files the previous compaction listed but no tool call in the branch explains (a
	// summary written by another extension, say) rank after everything the scan saw.
	const details = lastCompaction?.details as { readFiles?: unknown; modifiedFiles?: unknown } | undefined;
	for (const [paths, modified] of [[stringArray(details?.modifiedFiles), true], [stringArray(details?.readFiles), false]] as const) {
		for (const path of paths) {
			const absolute = resolveToolPath(path, cwd);
			if (!touched.has(absolute)) {
				touched.set(absolute, { modified });
				ranked.push([absolute, { modified }]);
			}
		}
	}

	// Merge spellings that name one file; the newest spelling wins, and a file counts
	// as modified if any spelling of it was.
	const byFile = new Map<string, { path: string; modified: boolean }>();
	let missing = 0;
	for (const [path, { modified }] of ranked) {
		const key = fileIdentity(path);
		if (key === undefined) {
			missing++;
			continue;
		}
		const file = byFile.get(key);
		if (file) file.modified ||= modified;
		else byFile.set(key, { path, modified });
	}

	let readCount = fileOps.read.size;
	let modifiedCount = new Set([...fileOps.edited, ...(fileOps.written ?? [])]).size;
	const stats: CarryForwardStats = { read: 0, modified: 0, candidates: byFile.size, missing };
	for (const [key, file] of byFile) {
		const shown = current.get(key);
		if (shown !== undefined) {
			// Already in the span. Keep that it was modified earlier even if the span only read it.
			if (file.modified && !fileOps.edited.has(shown) && !fileOps.written?.has(shown)) {
				fileOps.edited.add(shown);
				modifiedCount++;
			}
			continue;
		}
		if (file.modified ? modifiedCount >= MAX_CARRIED_FILE_OPS : readCount >= MAX_CARRIED_FILE_OPS) continue;
		if (file.modified) {
			fileOps.edited.add(file.path);
			modifiedCount++;
			stats.modified++;
		} else {
			fileOps.read.add(file.path);
			readCount++;
			stats.read++;
		}
		current.set(key, file.path);
	}
	return stats;
}
