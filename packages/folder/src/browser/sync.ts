import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import {
	type GitObject,
	hashObject,
	readCommit,
	readTree,
	writeCommit,
} from '../git/raw-objects.js';
import { mergeTrees, overrodeTrailer } from '../git/tree-merge.js';
import { parseRowSource, sameValue } from '../shared/content/canonical.js';
import { sameContent } from '../shared/merge.js';
import { includesCommit } from './git/ancestry.js';
import { snapshotObjects } from './git/closure.js';
import { emptyTree, withoutDeletedEntries } from './git/snapshot.js';
import {
	fetchRemote,
	type HttpRequest,
	pushRemote,
	TransferFailure,
} from './git/transfer.js';
import type { LocalRepository } from './repository.js';
import {
	type RepositoryState,
	type RepositoryStorage,
	StorageFailure,
} from './storage.js';

/** Git negotiation uses the incorporated base as its retained history boundary. */
function transferRefs(state: RepositoryState) {
	const base = state.remoteBase ?? null;
	return {
		base,
		shallow: base === null ? [] : [base],
	};
}

async function fileAt(
	root: string | null,
	path: string,
	read: (oid: string) => Promise<GitObject>,
) {
	if (root === null) return null;
	const parts = path.split('/');
	const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
	let oid = root;
	for (let index = 0; index < parts.length; index++) {
		const object = await read(oid);
		if (object.type !== 'tree') return null;
		const entry = readTree(object.bytes).find((entry) => {
			try {
				return decoder.decode(entry.name) === parts[index];
			} catch {
				return false;
			}
		});
		if (entry === undefined || entry.mode === '160000') return null;
		oid = entry.oid;
		if (index === parts.length - 1) {
			const file = await read(oid);
			return file.type === 'blob' ? file.bytes : null;
		}
	}
	return null;
}

export const SyncError = defineErrors({
	TransferFailed: ({ cause }: { cause: unknown }) => ({
		message: `Git transfer failed: ${extractErrorMessage(cause)}`,
		cause,
	}),
	StorageFailed: ({ cause }: { cause: unknown }) => ({
		message: `Repository synchronization storage failed: ${extractErrorMessage(cause)}`,
		cause,
	}),
	UnknownAncestry: () => ({
		message:
			'Fetched history does not establish the pending commit or confirmed base ancestry',
	}),
	RewrittenHistory: () => ({
		message: 'Server history no longer contains the incorporated base',
	}),
});
export type SyncError = InferErrors<typeof SyncError>;

/** Prepare one exact send; later saves do not replace an unsettled commit. */
export async function prepareCommit(
	storage: RepositoryStorage,
	author: Parameters<typeof writeCommit>[0]['author'],
) {
	for (;;) {
		const { state, baseTree } = await storage.checkpoint();
		const { remoteBase, pendingCommit, workingTree } = state;
		if (remoteBase === undefined) return null;
		if (pendingCommit !== null)
			return { base: remoteBase, head: pendingCommit };
		if (workingTree === (baseTree ?? emptyTree)) return null;
		const commit: GitObject = {
			type: 'commit',
			bytes: writeCommit({
				tree: workingTree,
				parents: remoteBase === null ? [] : [remoteBase],
				author,
				message: 'Save repository changes\n',
			}),
		};
		const head = await hashObject(commit);
		if (
			await storage.publish({
				expected: state,
				objects: new Map([[head, commit]]),
				refs: { remoteBase, pendingCommit: head },
			})
		)
			return { base: remoteBase, head };
	}
}

/**
 * Internal manual trigger, absent from the public Folder contract.
 * Each attempt fetches once (plus recovery if needed) and pushes at most once;
 * requests made during it share the same promise. Later scheduling is external.
 */
export function createSync(
	repository: LocalRepository,
	{
		url,
		author,
		request,
		signal,
	}: {
		url: string;
		author: () => Parameters<typeof writeCommit>[0]['author'];
		request?: HttpRequest;
		signal?: AbortSignal;
	},
) {
	let running: Promise<Result<void, SyncError>> | undefined;
	async function attempt(): Promise<Result<void, SyncError>> {
		try {
			await prepareCommit(repository.storage, author());
			const anchor = await repository.storage.capture('sync');
			let incoming = await fetchRemote({
				url,
				objects: anchor.objects,
				...transferRefs(anchor.state),
				initial: anchor.state.remoteBase === undefined,
				signal,
				request,
			});
			for (let recovery = 0; recovery < 2; recovery++) {
				// Transfer/unpacking finished before this root validation window.
				const snapshot = await repository.storage.capture('sync');
				const { remoteBase, pendingCommit, workingTree } = snapshot.state;
				if (remoteBase !== anchor.state.remoteBase) return Ok(undefined);
				const base = remoteBase ?? null;
				const head = pendingCommit ?? base;
				const objects = snapshot.objects;
				// Fetch can borrow any starting object, including uncommitted W
				// bytes that another tab has since replaced and collected.
				for (const captured of [anchor.objects, incoming.objects])
					for (const [oid, object] of captured)
						if (!objects.has(oid)) objects.set(oid, object);
				const read = async (oid: string) => {
					const object = objects.get(oid);
					if (object === undefined)
						throw new Error(`Sync input did not capture object ${oid}`);
					return object;
				};
				const rootOf = (oid: string | null) =>
					oid === null ? null : readCommit(objects.get(oid)!.bytes).tree;
				const remote = incoming.head;
				const pending = pendingCommit !== null;
				if (pending && remote === base) {
					return await push({
						base,
						head: pendingCommit,
						objects: snapshot.objects,
					});
				}
				const baseProof =
					base === null
						? 'included'
						: includesCommit({ tip: remote, target: base, objects });
				const pendingProof = !pending
					? 'excluded'
					: includesCommit({ tip: remote, target: head!, stop: base, objects });
				if (baseProof === 'unknown' || pendingProof === 'unknown') {
					if (recovery > 0) return SyncError.UnknownAncestry();
					incoming = await fetchRemote({
						url,
						objects: snapshot.objects,
						...transferRefs(snapshot.state),
						initial: false,
						recover: true,
						signal,
						request,
					});
					continue;
				}
				if (baseProof === 'excluded') return SyncError.RewrittenHistory();
				if (
					remoteBase !== undefined &&
					remote === head &&
					workingTree === (rootOf(head) ?? emptyTree) &&
					!pending
				)
					return Ok(undefined);
				const retain = (created: ReadonlyMap<string, GitObject>) => {
					for (const [oid, object] of created) objects.set(oid, object);
				};
				const local = workingTree;
				let current = rootOf(remote);
				let editBase = rootOf(head);
				const overridden: Awaited<ReturnType<typeof mergeTrees>>['overridden'] =
					[];
				if (pending && pendingProof === 'excluded') {
					// Remove witnessed deletions before importing remote edits. Otherwise
					// an unseen remote edit can resurrect the rejected send's deleted text.
					const deleted = await withoutDeletedEntries({
						root: editBase!,
						workingTree,
						read,
					});
					retain(deleted.objects);
					editBase = deleted.tree;
					const rebased = await mergeTrees({
						base: rootOf(base),
						current,
						change: editBase,
						read,
					});
					retain(rebased.objects);
					current = rebased.tree;
					overridden.push(...rebased.overridden);
				}
				const merged = await mergeTrees({
					base: editBase,
					current,
					change: local,
					read,
				});
				retain(merged.objects);
				overridden.push(...merged.overridden);
				let next = remote;
				const tree = merged.tree ?? emptyTree;
				objects.set(emptyTree, { type: 'tree', bytes: new Uint8Array() });
				if (tree !== (rootOf(remote) ?? emptyTree)) {
					const trailers = new Set<string>();
					if (remote !== null)
						for (const { path, unit } of overridden) {
							const before = await fileAt(rootOf(remote), path, read);
							const after = await fileAt(tree, path, read);
							if (sameContent(before, after)) continue;
							if (unit.kind === 'field' && before !== null && after !== null) {
								const oldRow = parseRowSource(new TextDecoder().decode(before));
								const newRow = parseRowSource(new TextDecoder().decode(after));
								if (
									oldRow.error === null &&
									newRow.error === null &&
									sameValue(
										oldRow.data.document.fields[unit.field],
										newRow.data.document.fields[unit.field],
									)
								)
									continue;
							}
							trailers.add(overrodeTrailer(remote, path, unit));
						}
					if (pending && pendingProof === 'excluded' && head !== null) {
						const message = new TextDecoder()
							.decode(objects.get(head)!.bytes)
							.split('\n\n')
							.slice(1)
							.join('\n\n');
						for (const line of message.split('\n'))
							if (line.startsWith('Overrode: ')) trailers.add(line);
					}
					const commit: GitObject = {
						type: 'commit',
						bytes: writeCommit({
							tree,
							parents: remote === null ? [] : [remote],
							author: author(),
							message: `Save repository changes\n${trailers.size ? `\n${[...trailers].join('\n')}\n` : ''}`,
						}),
					};
					next = await hashObject(commit);
					objects.set(next, commit);
				}
				const retained = await snapshotObjects(
					[remote, next].filter((oid) => oid !== null),
					read,
					[tree],
				);
				if (
					!(await repository.storage.publish({
						expected: snapshot.state,
						workingTree: tree,
						objects: retained,
						refs: {
							remoteBase: remote,
							pendingCommit: next === remote ? null : next,
						},
					}))
				)
					return Ok(undefined);
				if (next === remote) return Ok(undefined);
				return await push({
					base: remote,
					head: next!,
					objects: retained,
				});
			}
			return SyncError.UnknownAncestry();
		} catch (cause) {
			if (cause instanceof StorageFailure)
				return SyncError.StorageFailed({ cause });
			if (cause instanceof TransferFailure)
				return SyncError.TransferFailed({ cause });
			throw cause;
		}
	}
	async function push({
		base,
		head,
		objects,
	}: {
		base: string | null;
		head: string;
		objects: ReadonlyMap<string, GitObject>;
	}): Promise<Result<void, SyncError>> {
		const result = await pushRemote({
			url,
			objects,
			shallow: base === null ? [] : [base],
			base,
			head,
			signal,
			request,
		});
		if (result === 'rejected') return Ok(undefined);
		await repository.storage.acknowledge(base, head);
		return Ok(undefined);
	}
	return {
		/** A successful push can leave newer local edits waiting for another run. */
		run() {
			running ??= attempt().finally(() => {
				running = undefined;
			});
			return running;
		},
	};
}
