import { dirname, join } from "path";
import { pathToFileURL } from "url";
import type { BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";

// before_agent_start hands each extension whatever the previous ones made of the
// prompt, so an extension ahead of us in the chain (pi-hermes-memory appends a memory
// block) is indistinguishable from pi itself. What pi assembled is recoverable: the
// event carries the structured options it built from, and buildSystemPrompt is a pure
// function of them.

type BuildSystemPrompt = (options: BuildSystemPromptOptions) => string;

const PI_PACKAGE = "@earendil-works/pi-coding-agent";

let builder: BuildSystemPrompt | null | undefined;

/** pi exports `BuildSystemPromptOptions` but not the builder, and its `exports` map has
 *  no subpath for it, so reach the module by file URL. A pi that moves or renames it
 *  leaves `basePromptKey` on its fallback. */
async function loadBuilder(): Promise<BuildSystemPrompt | null> {
	if (builder !== undefined) return builder;
	builder = null;
	for (const root of piRoots()) {
		try {
			const module = await import(new URL("./dist/core/system-prompt.js", root).href);
			if (typeof module.buildSystemPrompt === "function") {
				builder = module.buildSystemPrompt;
				break;
			}
		} catch {
			// Not pi, or not this pi's layout. Failing every root keys on what we were handed.
		}
	}
	return builder;
}

/** Ancestors of the running pi's entry point, innermost first, so the pi executing this
 *  turn is found before the one resolved by specifier — which is whatever sits beside
 *  *this* file, for a checkout its own devDependency. A pi of another version builds a
 *  different prompt, and a prompt that reproduces nothing is no key at all. */
function piRoots(): URL[] {
	const roots: URL[] = [];
	let dir = process.argv[1] ? dirname(process.argv[1]) : undefined;
	while (dir) {
		roots.push(pathToFileURL(join(dir, "/")));
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	try {
		// .../dist/index.js -> the package root.
		roots.push(new URL("../", import.meta.resolve(PI_PACKAGE)));
	} catch {
		// Nothing beside us; the running pi is the only candidate.
	}
	return roots;
}

/** What pi assembled before any before_agent_start handler saw it, or undefined when it
 *  cannot be reproduced. */
export async function reconstructBasePrompt(options: BuildSystemPromptOptions | undefined): Promise<string | undefined> {
	if (!options) return undefined;
	const build = await loadBuilder();
	try {
		return build?.(options);
	} catch {
		return undefined;
	}
}

/**
 * The key to record one turn's capture under: pi's own assembled prompt when it can be
 * reproduced and the handed-down prompt still contains it, else what we were handed.
 *
 * Keying on a wrapper costs twice. Its added text is not in the capture — projection
 * emits only pi's portable parts — so it reaches Claude Code as nothing at all; and pi
 * still runs turns on its unwrapped base prompt, which then matches no key and fails
 * the turn. Keyed on the base, the base resolves exactly and the wrapped prompt resolves
 * through `resolveOrDerive`'s embed path, which substitutes the capture and carries
 * every surrounding byte — the wrapper's included — through unchanged.
 */
export async function basePromptKey(systemPrompt: string, options: BuildSystemPromptOptions | undefined): Promise<string> {
	const base = await reconstructBasePrompt(options);
	// Not embedded means the reconstruction is wrong (a pi whose builder no longer
	// matches these options) or an extension rebuilt rather than wrapped. Either way the
	// reconstruction is not a key any turn will present.
	return base && systemPrompt.includes(base) ? base : systemPrompt;
}
