import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { createLogger } from 'wellcrafted/logger';
import { Ok, type Result } from 'wellcrafted/result';
import { parseRowSource, sameValue } from './content/canonical.js';
import { includesCommit } from './git/ancestry.js';
import { snapshotObjects } from './git/closure.js';
import { mergeTrees } from './git/merge.js';
import {
	type GitObject,
	hashObject,
	readCommit,
	readTree,
	writeCommit,
	writeTree,
} from './git/objects.js';
import { changeSnapshot } from './git/snapshot.js';
import {
	fetchRemote,
	type HttpRequest,
	pushRemote,
	TransferFailure,
} from './git/transfer.js';
import { sameContent } from './merge.js';
import type { LocalRepository, SaveError } from './repository.js';
import { StorageFailure } from './storage.js';

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
type SyncOutcome = { outcome: 'accepted' | 'unchanged' | 'pending' };
const log = createLogger('data-sync');

/**
 * Internal manual trigger. The future public open owns one instance per handle.
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
	let running: Promise<Result<SyncOutcome, SyncError | SaveError>> | undefined;
	let publishedSnapshot = false;
	async function attempt(): Promise<
		Result<SyncOutcome, SyncError | SaveError>
	> {
		publishedSnapshot = false;
		try {
			const prepared = await repository.prepareCommit(author());
			if (prepared.error !== null) return prepared;
			const anchor = await repository.storage.capture('sync');
			let incoming = await fetchRemote({
				url,
				input: { objects: anchor.objects, refs: anchor.state },
				initial: !anchor.state.remoteKnown,
				signal,
				request,
			});
			for (let recovery = 0; recovery < 2; recovery++) {
				// Transfer/unpacking finished before this revision validation window.
				const snapshot = await repository.storage.capture('sync');
				const { base, head, revision } = snapshot.state;
				if (base !== anchor.state.base) return Ok({ outcome: 'pending' });
				const objects = new Map([...incoming.objects, ...snapshot.objects]);
				const read = async (oid: string) => {
					const object = objects.get(oid);
					if (object === undefined)
						throw new Error(`Sync input did not capture object ${oid}`);
					return object;
				};
				const rootOf = (oid: string | null) =>
					oid === null ? null : readCommit(objects.get(oid)!.bytes).tree;
				const remote = incoming.head;
				const pending = head !== base;
				if (pending && remote === base) {
					if (head === null)
						throw new Error('Confirmed base without a current commit');
					return await push({
						base,
						head,
						objects: snapshot.objects,
						shallow: snapshot.state.shallow,
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
						input: { objects: snapshot.objects, refs: snapshot.state },
						initial: false,
						recover: true,
						signal,
						request,
					});
					continue;
				}
				if (baseProof === 'excluded') return SyncError.RewrittenHistory();
				if (
					snapshot.state.remoteKnown &&
					remote === head &&
					snapshot.edits.size === 0 &&
					!pending
				)
					return Ok({ outcome: 'unchanged' });
				const retain = (created: ReadonlyMap<string, GitObject>) => {
					for (const [oid, object] of created) objects.set(oid, object);
				};
				let local = rootOf(head);
				if (snapshot.edits.size > 0) {
					const edited = await changeSnapshot({
						root: local,
						edits: snapshot.edits,
						read,
					});
					retain(edited.objects);
					local = edited.tree;
				}
				let current = rootOf(remote);
				let editBase = rootOf(head);
				const overridden: Awaited<ReturnType<typeof mergeTrees>>['overridden'] =
					[];
				if (pending && pendingProof === 'excluded') {
					// Remove witnessed deletions before importing remote edits. Otherwise
					// an unseen remote edit can resurrect C's already-deleted text.
					const deletions = new Map(
						[...snapshot.edits].filter(([, text]) => text === null),
					);
					if (deletions.size > 0) {
						const deleted = await changeSnapshot({
							root: editBase,
							edits: deletions,
							read,
						});
						retain(deleted.objects);
						editBase = deleted.tree;
					}
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
				if (merged.tree !== rootOf(remote)) {
					let tree = merged.tree;
					if (tree === null) {
						const empty: GitObject = { type: 'tree', bytes: writeTree([]) };
						tree = await hashObject(empty);
						objects.set(tree, empty);
					}
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
							const words =
								unit.kind === 'field'
									? `field=${JSON.stringify(unit.field)}`
									: unit.kind === 'lines'
										? `lines=${unit.part}:${unit.line}+${unit.count}`
										: 'file';
							trailers.add(
								`Overrode: ${remote} ${words} ${JSON.stringify(path)}`,
							);
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
				);
				if (
					!(await repository.storage.publish({
						revision,
						objects: retained,
						remoteKnown: true,
						refs: {
							base: remote,
							head: next,
							shallow: remote === null ? [] : [remote],
						},
						edits: new Map(
							[...snapshot.edits.keys()].map((path) => [path, undefined]),
						),
					}))
				)
					return Ok({ outcome: 'pending' });
				publishedSnapshot = true;
				if (next === remote)
					return Ok({ outcome: pending ? 'accepted' : 'unchanged' });
				return await push({
					base: remote,
					head: next!,
					objects: retained,
					shallow: remote === null ? [] : [remote],
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
		shallow,
	}: {
		base: string | null;
		head: string;
		objects: ReadonlyMap<string, GitObject>;
		shallow: readonly string[];
	}): Promise<Result<SyncOutcome, SyncError>> {
		const result = await pushRemote({
			url,
			input: { objects, refs: { base, head, shallow } },
			base,
			head,
			signal,
			request,
		});
		if (result === 'rejected') return Ok({ outcome: 'pending' });
		const acknowledged = await repository.storage.acknowledge(base, head);
		if (acknowledged) publishedSnapshot = true;
		return Ok({ outcome: acknowledged ? 'accepted' : 'pending' });
	}
	return {
		/** A successful push can leave newer local edits waiting for another run. */
		run() {
			running ??= attempt()
				.then(async (result) => {
					if (publishedSnapshot) {
						try {
							await repository.storage.collect();
						} catch (cause) {
							// Collection is best effort; accepted work stays published.
							log.warn(SyncError.StorageFailed({ cause }));
						}
					}
					return result;
				})
				.finally(() => {
					running = undefined;
				});
			return running;
		},
	};
}
