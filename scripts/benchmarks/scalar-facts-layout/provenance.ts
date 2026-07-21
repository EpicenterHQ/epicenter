/**
 * Observed source provenance for the evidence artifact. Provenance is DERIVED
 * (a validated git HEAD, a scoped dirty check, a deterministic content digest
 * over the exact evidence-producing sources), never trusted from an arbitrary
 * environment string. Unrelated app dirt cannot poison the scoped digest or the
 * scoped dirty check, because both range over exactly the listed sources.
 *
 * The helpers here are pure over injected inputs (file contents and a git
 * runner), so they are unit-testable without a real filesystem or git.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

/** One source file's exact content, keyed by its repo-relative path. */
export type SourceFile = { path: string; content: string };

/**
 * A deterministic SHA-256 over the sorted (path, byte-length, content) triples.
 * Sorting makes it order-independent; the length prefix makes it unambiguous. A
 * file outside this set never affects the digest.
 */
export function sourceManifestDigest(files: SourceFile[]): string {
	const encoder = new TextEncoder();
	const sorted = [...files].sort((a, b) =>
		a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
	);
	const hasher = sha256.create();
	for (const file of sorted) {
		const bytes = encoder.encode(file.content);
		hasher.update(encoder.encode(`${file.path}\n${bytes.length}\n`));
		hasher.update(bytes);
		hasher.update(encoder.encode('\n'));
	}
	return bytesToHex(hasher.digest());
}

/** A git invocation result: whether it succeeded and its captured stdout. */
export type GitResult = { ok: boolean; stdout: string };
/** Runs a git subcommand; an unavailable git returns `{ ok: false }`. */
export type GitRunner = (args: string[]) => GitResult;

/** The validated 40-hex git HEAD, or null when git is unavailable or output is malformed. */
export function gitHead(run: GitRunner): string | null {
	const result = run(['rev-parse', 'HEAD']);
	if (!result.ok) return null;
	const head = result.stdout.trim();
	return /^[0-9a-f]{40}$/.test(head) ? head : null;
}

/**
 * Whether any of the scoped repo-relative `paths` is modified, staged, or
 * untracked. Null when git is unavailable. Because it passes exactly `paths` to
 * `git status --porcelain`, unrelated dirt elsewhere in the tree is ignored.
 */
export function relevantDirty(run: GitRunner, paths: string[]): boolean | null {
	const result = run(['status', '--porcelain', '--', ...paths]);
	if (!result.ok) return null;
	return result.stdout.trim().length > 0;
}

export type Provenance = {
	gitHead: string | null;
	relevantSourcesDirty: boolean | null;
	sourceManifestSha256: string;
	sourceManifestFiles: string[];
	/** A run is source-admissible only with a known HEAD and a clean relevant tree. */
	sourceProvenanceAdmissible: boolean;
};

/** Derive the full provenance record from the source contents and a git runner. */
export function deriveProvenance(
	files: SourceFile[],
	run: GitRunner,
): Provenance {
	const head = gitHead(run);
	const dirty = relevantDirty(
		run,
		files.map((f) => f.path),
	);
	return {
		gitHead: head,
		relevantSourcesDirty: dirty,
		sourceManifestSha256: sourceManifestDigest(files),
		sourceManifestFiles: [...files.map((f) => f.path)].sort(),
		sourceProvenanceAdmissible: head !== null && dirty === false,
	};
}
