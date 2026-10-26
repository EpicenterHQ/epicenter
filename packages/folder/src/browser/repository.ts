import { Ok, type Result } from 'wellcrafted/result';
import { hashObject } from '../git/raw-objects.js';
import { pathProblem, readablePath, writableExistingPath } from '../paths.js';
import { SaveError } from '../shared/errors.js';
import { type FileContent, sameContent } from '../shared/merge.js';
import { changeSnapshot } from './git/snapshot.js';
import {
	openStorage,
	type RepositorySnapshot,
	StorageFailure,
	snapshotContent,
	snapshotObject,
} from './storage.js';

const validPath = (path: string) =>
	readablePath(path) && pathProblem(path) === undefined;

/** Text a file write can store: UTF-8 without NUL or lone surrogates. */
const storableText = (text: string) =>
	!text.includes('\0') && text.isWellFormed();

function caseTwin(
	path: string,
	{ files, directories }: RepositorySnapshot,
): string | undefined {
	if (files.has(path) || directories.has(path)) return undefined;
	const parts = path.split('/');
	for (const paths of [files.keys(), directories])
		for (const existing of paths) {
			const other = existing.split('/');
			for (
				let index = 0;
				index < Math.min(parts.length, other.length);
				index++
			) {
				if (parts[index]!.toLowerCase() !== other[index]!.toLowerCase()) break;
				if (parts[index] !== other[index])
					return other.slice(0, index + 1).join('/');
			}
		}
	return undefined;
}

/**
 * Internal local engine, absent from the package exports. The public opener
 * owns this handle; sync separately owns credentials and network work.
 */
export async function openRepository(id: string) {
	const storage = await openStorage(id);
	function assertOpen() {
		if (storage.closed) throw new Error('Repository is closed');
	}

	/**
	 * Put `content` at `path`, or remove its file for `null`. Each attempt
	 * publishes over the current tree. The last write of this path to land wins.
	 */
	async function put(
		path: string,
		written: FileContent | null,
	): Promise<Result<{ landed: { version: string } | null }, SaveError>> {
		assertOpen();
		const content = written instanceof Uint8Array ? written.slice() : written;
		try {
			if (!writableExistingPath(path)) return SaveError.InvalidPath({ path });
			if (typeof content === 'string' && !storableText(content))
				return SaveError.NotText();
			for (;;) {
				// Trees identify structural collisions; only this path needs blob bytes.
				const snapshot = await storage.capture([path]);
				const current = snapshotContent(snapshot, path);
				if (content !== null) {
					if (!validPath(path) && !snapshot.files.has(path))
						return SaveError.InvalidPath({ path });
					const twin = caseTwin(path, snapshot);
					if (twin !== undefined)
						return SaveError.CaseTwin({ path, existing: twin });
					if (snapshot.directories.has(path))
						return SaveError.Occupied({
							path,
							existing: path,
							kind: 'directory',
						});
					for (
						let end = path.lastIndexOf('/');
						end > 0;
						end = path.lastIndexOf('/', end - 1)
					) {
						const parent = path.slice(0, end);
						if (snapshot.files.has(parent))
							return SaveError.Occupied({
								path,
								existing: parent,
								kind: 'file',
							});
					}
				}
				const landed = async () =>
					Ok({
						landed:
							content === null
								? null
								: {
										version: await hashObject({
											type: 'blob',
											bytes:
												typeof content === 'string'
													? new TextEncoder().encode(content)
													: content,
										}),
									},
					});
				if (sameContent(content, current)) return landed();
				const candidate = await changeSnapshot({
					root: snapshot.state.workingTree,
					edits: new Map([[path, content]]),
					read: async (oid) => snapshotObject(snapshot, oid),
				});
				if (
					await storage.publish({
						expected: snapshot.state.workingTree,
						workingTree: candidate.tree,
						objects: candidate.objects,
						retiredBytes: [...snapshot.objects.values()].reduce(
							(sum, object) => sum + object.bytes.byteLength,
							0,
						),
						paths: [path],
					})
				)
					return landed();
			}
		} catch (cause) {
			if (!(cause instanceof StorageFailure)) throw cause;
			return SaveError.StorageFailed({ cause });
		}
	}

	return {
		/** Internal shared durable owner, used by sync and transaction evidence. */
		storage,
		put,

		/** Listen for committed file changes; storage owns the connection lifetime. */
		onChange: storage.subscribe,
		close: storage.close,
	};
}

export type LocalRepository = Awaited<ReturnType<typeof openRepository>>;
