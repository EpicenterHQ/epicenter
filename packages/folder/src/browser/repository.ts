import type { TSchema as Schema } from 'typebox';
import { Ok, type Result } from 'wellcrafted/result';
import { pathProblem, readablePath, writableExistingPath } from '../paths.js';
import { ReadError, SaveError } from '../shared/errors.js';
import { type FileContent, sameContent } from '../shared/merge.js';
import { type Row, readRow } from '../shared/row.js';
import { hashObject } from '../git/raw-objects.js';
import { changeSnapshot } from './git/snapshot.js';
import {
	openStorage,
	type RepositorySnapshot,
	StorageFailure,
	snapshotContent,
	snapshotObject,
} from './storage.js';

export { ReadError, SaveError } from '../shared/errors.js';

const validPath = (path: string) =>
	readablePath(path) && pathProblem(path) === undefined;

const readableId = (table: string, id: string) =>
	typeof id === 'string' &&
	!id.includes('/') &&
	readablePath(`${table}/${id}.md`);

/** Text a file write can store: UTF-8 without NUL or lone surrogates. */
const storableText = (text: string) =>
	!text.includes('\0') && text.isWellFormed();

/** A table is one top-level directory. */
export const isTableName = (name: string) =>
	typeof name === 'string' &&
	name.isWellFormed() &&
	!name.includes('/') &&
	pathProblem(name) === undefined;

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
export async function openRepository<
	const TTables extends Record<string, Schema> = Record<never, never>,
>(id: string, schemas: TTables = {} as TTables) {
	// Refuse before opening a database connection that would then leak.
	for (const name of Object.keys(schemas))
		if (!isTableName(name))
			throw new Error(`Table name must be one filename segment: ${name}`);
	const storage = await openStorage(id);
	function assertOpen() {
		if (storage.closed) throw new Error('Repository is closed');
	}

	async function read<T>(
		work: () => Promise<T>,
	): Promise<Result<T, ReadError>> {
		assertOpen();
		try {
			return Ok(await work());
		} catch (cause) {
			if (!(cause instanceof StorageFailure)) throw cause;
			return ReadError.StorageFailed({ cause });
		}
	}

	async function save<T>(
		work: () => Promise<Result<T, SaveError>>,
	): Promise<Result<T, SaveError>> {
		assertOpen();
		try {
			return await work();
		} catch (cause) {
			if (!(cause instanceof StorageFailure)) throw cause;
			return SaveError.StorageFailed({ cause });
		}
	}

	/**
	 * Put `content` at `path`, or remove its file for `null`, whatever is
	 * there. Each attempt publishes over the working tree it read, which only
	 * guards the tree's other paths: another commit landing meanwhile starts
	 * the next attempt, and the last write of the path to land wins. An
	 * existing name that only some disks hold may be replaced or removed,
	 * never made.
	 */
	function saveFile(path: string, written: FileContent | null) {
		return putFile(path, written, 'any').then(
			(result): Result<void, SaveError> =>
				result.error === null ? Ok(undefined) : result,
		);
	}

	/**
	 * Put `content` at `path`, or remove its file for `null`, only while the
	 * path holds what `expected` says: no file, or a blob with that oid. A
	 * mismatch is `'stale'` and changes nothing. Lands with the new blob oid.
	 */
	function putFile(
		path: string,
		written: FileContent | null,
		expected: 'any' | 'absent' | { readonly version: string },
	) {
		const content = written instanceof Uint8Array ? written.slice() : written;
		return save(
			async (): Promise<
				Result<{ landed: { version: string } | null } | 'stale', SaveError>
			> => {
			if (!writableExistingPath(path)) return SaveError.InvalidPath({ path });
			if (typeof content === 'string' && !storableText(content))
				return SaveError.NotText();
			for (;;) {
				// Trees identify structural collisions; only this path needs blob bytes.
				const snapshot = await storage.capture([path]);
				const current = snapshotContent(snapshot, path);
				const entry = snapshot.files.get(path);
				if (expected === 'absent' && entry !== undefined) return Ok('stale');
				if (typeof expected === 'object' && entry?.oid !== expected.version)
					return Ok('stale');
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
			},
		);
	}

	function table<const TSchema extends Schema>(name: string, schema: TSchema) {
		const rowPath = (id: string) => `${name}/${id}.md`;
		return {
			list() {
				return read(async () => {
					const snapshot = await storage.capture({ rows: name });
					const rows: Row<TSchema>[] = [];
					for (const path of [...snapshot.files.keys()].sort()) {
						if (!path.startsWith(`${name}/`) || !path.endsWith('.md')) continue;
						const id = path.slice(name.length + 1, -3);
						if (!readableId(name, id)) continue;
						const content = snapshotContent(snapshot, path);
						if (content !== null) rows.push(readRow(id, content, schema));
					}
					return rows;
				});
			},
			get(id: string) {
				return read(async () => {
					if (!readableId(name, id)) return undefined;
					const content = snapshotContent(
						await storage.capture([rowPath(id)]),
						rowPath(id),
					);
					return content === null ? undefined : readRow(id, content, schema);
				});
			},
		};
	}

	function files() {
		return {
			list(prefix = '') {
				return read(async () => {
					if (prefix !== '' && !readablePath(prefix.replace(/\/$/, '')))
						return [];
					const snapshot = await storage.capture({ prefix });
					return [...snapshot.files.keys()]
						.filter(
							(path) =>
								snapshot.files.get(path)?.mode !== '160000' &&
								path.startsWith(prefix),
						)
						.sort();
				});
			},
			read(path: string) {
				return read(async () => {
					if (!readablePath(path)) return undefined;
					const content = snapshotContent(await storage.capture([path]), path);
					if (content === null) return undefined;
					return { path, content: new Blob([new Uint8Array(content)]) };
				});
			},
			/** Replace whatever is at `path` with `content`. */
			async write(
				path: string,
				content: FileContent,
			): Promise<Result<void, SaveError>> {
				assertOpen();
				return saveFile(path, content);
			},
			/** Remove the file at `path`; a file that is not there is already gone. */
			async delete(path: string): Promise<Result<void, SaveError>> {
				assertOpen();
				return saveFile(path, null);
			},
		};
	}

	return {
		id,
		/** Internal shared durable owner, used by sync and transaction evidence. */
		storage,
		files: files(),
		tables: Object.fromEntries(
			Object.entries(schemas).map(([name, schema]) => [
				name,
				table(name, schema),
			]),
		) as {
			[TName in keyof TTables]: ReturnType<typeof table<TTables[TName]>>;
		},

		/** A conditional put, for the folder's host. */
		put: putFile,

		/** Listen for committed file changes; storage owns the connection lifetime. */
		onChange: storage.subscribe,
		close: storage.close,
	};
}

export type LocalRepository = Awaited<ReturnType<typeof openRepository>>;
