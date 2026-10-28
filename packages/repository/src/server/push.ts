/**
 * An agent's `git push`. The pushed commits are not replayed: the net change
 * from the merge base with `main` to the pushed commit becomes one batch under
 * the `'refuse'` policy, and the result is committed with the pushed commit as a
 * parent, so the agent's history stays in `main`.
 */
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { parseMarkdown, parsePointer } from '../markdown.js';
import type { Change, ChangeOutcome, Overlap } from '../protocol.js';
import { sequenceOf, type Tree } from './git-store.js';
import type { CommitError, ServerCore } from './server.js';

/** Notes larger than this, stored, are refused. */
export const MAX_NOTE_BYTES = 1024 * 1024;

export const PushError = defineErrors({
	/** The pushed commit is not in the Git store. */
	UnknownCommit: ({ commit }: { commit: string }) => ({
		message: `The pushed commit ${commit} is not in the repository`,
		commit,
	}),
});
export type PushError = InferErrors<typeof PushError> | CommitError;

export type PushOutcome =
	| { kind: 'applied'; commit: string; seq: number; changes: ChangeOutcome[] }
	/** The push changed nothing since its merge base. */
	| { kind: 'unchanged' }
	| { kind: 'refused'; path: string; reason: string; overlaps: Overlap[] };

const utf8 = new TextDecoder('utf-8', { fatal: true });

export async function receivePush(
	core: ServerCore,
	{ commit, user }: { commit: string; user: string },
): Promise<Result<PushOutcome, PushError>> {
	const { git } = core;
	const pushed = await git.readCommit(commit);
	if (pushed === null) return PushError.UnknownCommit({ commit });
	const main = await core.loadMain();
	const baseOid = main.oid === null ? null : await git.mergeBase(commit, main.oid);
	const baseTree: Tree = baseOid === null ? new Map() : await treeOf(core, baseOid);
	const pushedTree = await git.readTree(pushed.tree);

	const added: string[] = [];
	const deleted: string[] = [];
	const modified: string[] = [];
	for (const [path, entry] of pushedTree) {
		const before = baseTree.get(path);
		if (before === undefined) added.push(path);
		else if (before.oid !== entry.oid) modified.push(path);
	}
	for (const path of baseTree.keys()) if (!pushedTree.has(path)) deleted.push(path);

	// Read and check every new or changed file before building the batch.
	const texts = new Map<string, string>();
	for (const path of [...added, ...modified]) {
		const oid = pushedTree.get(path)?.oid ?? '';
		const bytes = (await git.readBlob(oid)) ?? new Uint8Array();
		const refusal = checkFile(path, bytes);
		if (refusal !== null) return refuse(core, path, refusal);
		texts.set(path, utf8.decode(bytes));
	}
	const baseText = async (path: string) => {
		const entry = baseTree.get(path);
		return entry === undefined ? null : core.gitText(entry.oid);
	};

	// Rename detection: same blob, or a Markdown file at least half unchanged.
	const changes: Change[] = [];
	const renamed = new Map<string, string>();
	for (const to of added) {
		const oid = pushedTree.get(to)?.oid;
		let from = deleted.find((path) => !renamed.has(path) && baseTree.get(path)?.oid === oid);
		if (from === undefined && to.endsWith('.md'))
			for (const candidate of deleted) {
				if (renamed.has(candidate) || !candidate.endsWith('.md')) continue;
				const before = await baseText(candidate);
				if (before !== null && similarity(before, texts.get(to) ?? '') >= 0.5) {
					from = candidate;
					break;
				}
			}
		if (from !== undefined) renamed.set(from, to);
	}
	for (const [from, to] of renamed)
		changes.push({ kind: 'move', from, to });
	for (const [from, to] of renamed) {
		if (baseTree.get(from)?.oid === pushedTree.get(to)?.oid) continue;
		const before = (await baseText(from)) ?? '';
		changes.push({ kind: 'write', path: to, base: { hash: baseTree.get(from)?.oid ?? '', text: before }, text: texts.get(to) ?? '' });
	}
	for (const path of added) {
		if ([...renamed.values()].includes(path)) continue;
		changes.push({ kind: 'write', path, base: null, text: texts.get(path) ?? '' });
	}
	for (const path of modified)
		changes.push({
			kind: 'write',
			path,
			base: { hash: baseTree.get(path)?.oid ?? '', text: (await baseText(path)) ?? '' },
			text: texts.get(path) ?? '',
		});
	for (const path of deleted) {
		if (renamed.has(path)) continue;
		changes.push({ kind: 'write', path, base: { hash: baseTree.get(path)?.oid ?? '', text: (await baseText(path)) ?? '' }, text: null });
	}
	if (changes.length === 0) return Ok({ kind: 'unchanged' });

	const batch = { device: 'git-push', n: 0, seq: baseOid === null ? 0 : await sequenceAt(core, baseOid), changes };
	const peer = { device: 'git-push', user, onOverlap: 'refuse' as const };
	const { outcome, broadcast } = await core.applyBatch(batch, peer, false);
	if (outcome.kind === 'refused') return refuse(core, outcome.path, outcome.reason, outcome.overlaps);
	// A push is not numbered and sends its bases, so an applied one always has
	// its sequence and need-base cannot happen.
	if (outcome.kind !== 'applied' || outcome.seq === null || broadcast === null)
		return refuse(core, '', 'the server could not read the push\'s bases');
	const committed = await core.commitNow([commit]);
	if (committed.error !== null) return Err(committed.error);
	core.broadcast(broadcast, null);
	return Ok({ kind: 'applied', commit: committed.data?.oid ?? '', seq: outcome.seq, changes: outcome.changes });
}

/** A refusal first commits the overlay, so the agent's next pull is current. */
async function refuse(
	core: ServerCore,
	path: string,
	reason: string,
	overlaps: Overlap[] = [],
): Promise<Result<PushOutcome, PushError>> {
	const committed = await core.commitNow();
	if (committed.error !== null) return Err(committed.error);
	return Ok({ kind: 'refused', path, reason, overlaps });
}

function checkFile(path: string, bytes: Uint8Array): string | null {
	let text: string;
	try {
		text = utf8.decode(bytes);
	} catch {
		return 'a binary file must be stored through Git LFS';
	}
	if (text.includes('\0')) return 'a binary file must be stored through Git LFS';
	if (parsePointer(text) !== null) return null;
	if (!path.endsWith('.md')) return null;
	if (bytes.length > MAX_NOTE_BYTES) return 'a note may be at most 1 MB';
	const parsed = parseMarkdown(text);
	return parsed.error === null ? null : parsed.error.message;
}

async function treeOf(core: ServerCore, oid: string): Promise<Tree> {
	const info = await core.git.readCommit(oid);
	return info === null ? new Map() : core.git.readTree(info.tree);
}

/** The server sequence a commit includes: its own trailer or its first parent's. */
async function sequenceAt(core: ServerCore, oid: string): Promise<number> {
	let at: string | undefined = oid;
	for (let depth = 0; at !== undefined && depth < 1000; depth++) {
		const info = await core.git.readCommit(at);
		if (info === null) return 0;
		const seq = sequenceOf(info.message);
		if (seq !== null) return seq;
		at = info.parents[0];
	}
	return 0;
}

/** Shared lines over all lines: 1 for identical texts, 0 for disjoint ones. */
function similarity(a: string, b: string) {
	const left = a.split('\n');
	const right = new Map<string, number>();
	for (const line of b.split('\n')) right.set(line, (right.get(line) ?? 0) + 1);
	let shared = 0;
	for (const line of left) {
		const count = right.get(line) ?? 0;
		if (count > 0) {
			shared++;
			right.set(line, count - 1);
		}
	}
	return (2 * shared) / (left.length + b.split('\n').length);
}
