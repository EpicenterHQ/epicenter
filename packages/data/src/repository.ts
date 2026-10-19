import type { TSchema as Schema } from 'typebox';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { type GitObject, hashObject, writeCommit } from './git/objects.js';
import { changeSnapshot } from './git/snapshot.js';
import { type FileContent, merge, sameContent } from './merge.js';
import { type Row, type RowChange, readRow, rowChange } from './row.js';
import {
	openStorage,
	type RepositorySnapshot,
	StorageFailure,
	shadowed,
	snapshotContent,
	snapshotDirectories,
	snapshotObject,
	snapshotPaths,
} from './storage.js';

export const ReadError = defineErrors({
	StorageFailed: ({ cause }: { cause: unknown }) => ({
		message: `Repository read failed: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type ReadError = InferErrors<typeof ReadError>;

export const SaveError = defineErrors({
	InvalidId: ({ id }: { id: string }) => ({
		message: `Row id must be one filename segment: ${id}`,
		id,
	}),
	InvalidPath: ({ path }: { path: string }) => ({
		message: `Invalid repository path: ${path}`,
		path,
	}),
	CaseTwin: ({ path, existing }: { path: string; existing: string }) => ({
		message: `Path ${path} differs from ${existing} only by case`,
		path,
		existing,
	}),
	Occupied: ({
		path,
		existing,
		kind,
	}: {
		path: string;
		existing: string;
		kind: 'file' | 'directory';
	}) => ({
		message: `Cannot save ${path}: ${existing} is a ${kind}`,
		path,
		existing,
		kind,
	}),
	NotText: () => ({
		message: 'Repository writes require UTF-8 text without NUL bytes',
	}),
	Unparseable: ({ reason }: { reason: string }) => ({
		message: `Row fields cannot be saved: ${reason}`,
		reason,
	}),
	StorageFailed: ({ cause }: { cause: unknown }) => ({
		message: `Repository save failed: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type SaveError = InferErrors<typeof SaveError>;

const encoder = new TextEncoder();

/** Exact request identity captured by the transaction that published pending C. */
export type PendingCommit = { base: string | null; head: string };

function validPath(path: string): boolean {
	return (
		typeof path === 'string' &&
		path.length > 0 &&
		!path.includes('\0') &&
		path.isWellFormed() &&
		!path
			.split('/')
			.some(
				(part) =>
					part === '' ||
					part === '.' ||
					part === '..' ||
					part.toLowerCase() === '.git',
			)
	);
}

const validId = (id: string) => validPath(id) && !id.includes('/');

function caseTwin(
	path: string,
	paths: ReadonlySet<string>,
): string | undefined {
	if (paths.has(path)) return undefined;
	const parts = path.split('/');
	for (const existing of paths) {
		const other = existing.split('/');
		for (let index = 0; index < Math.min(parts.length, other.length); index++) {
			if (parts[index]!.toLowerCase() !== other[index]!.toLowerCase()) break;
			if (parts[index] !== other[index])
				return other.slice(0, index + 1).join('/');
		}
	}
	return undefined;
}

/** Normalize E against C, so restoring C removes a pending edit rather than adding work. */
function editPatch(
	snapshot: RepositorySnapshot,
	changes: ReadonlyMap<string, string | null>,
) {
	const patch = new Map<string, string | null | undefined>();
	const prospective = new Map([...snapshot.edits, ...changes]);
	for (const [path, text] of changes) {
		const entry = snapshot.head.files.get(path);
		if (text === null) {
			patch.set(
				path,
				entry === undefined && !snapshot.head.directories.has(path)
					? undefined
					: null,
			);
			continue;
		}
		const committed =
			entry === undefined || entry.mode === '160000'
				? null
				: snapshotObject(snapshot, entry.oid).bytes;
		const slash = path.lastIndexOf('/');
		const parent = slash < 0 ? '' : path.slice(0, slash);
		patch.set(
			path,
			sameContent(text, committed) && !shadowed(prospective, parent)
				? undefined
				: text,
		);
	}
	return patch;
}

/**
 * Internal local engine. The eventual app-facing open owns grants and network
 * lifetime; this constructor is deliberately absent from the package exports.
 */
export async function openRepository<
	const TTables extends Record<string, Schema> = Record<never, never>,
>(id: string, schemas: TTables = {} as TTables) {
	const storage = await openStorage(id);
	let closed = false;
	function assertOpen() {
		if (closed) throw new Error('Repository is closed');
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

	async function saveFile(
		path: string,
		from: FileContent | null,
		text: string | null,
		rowFields = false,
	) {
		// A mutable caller buffer must not change the edit's witness during retries.
		const base = from instanceof Uint8Array ? from.slice() : from;
		return save(async () => {
			if (!validPath(path)) return SaveError.InvalidPath({ path });
			if (
				text !== null &&
				(typeof text !== 'string' ||
					text.includes('\0') ||
					!text.isWellFormed())
			)
				return SaveError.NotText();
			for (;;) {
				// Trees identify structural collisions; only this path needs blob bytes.
				const snapshot = await storage.capture([path]);
				const paths = snapshotPaths(snapshot);
				if (text !== null) {
					const directories = snapshotDirectories(snapshot);
					const twin = caseTwin(path, new Set([...paths, ...directories]));
					if (twin !== undefined)
						return SaveError.CaseTwin({ path, existing: twin });
					if (directories.has(path))
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
						if (paths.has(parent))
							return SaveError.Occupied({
								path,
								existing: parent,
								kind: 'file',
							});
					}
				}
				const current = snapshotContent(snapshot, path);
				if (rowFields && current !== null) {
					const row = readRow('', current, {});
					const problem = row.issues?.[0];
					if (problem?.kind === 'not-text') return SaveError.NotText();
					if (problem?.kind === 'frontmatter')
						return SaveError.Unparseable({ reason: problem.message });
				}
				const merged = await merge(path, { base, current, change: text });
				if (sameContent(merged.content, current))
					return Ok({
						deleted:
							merged.content === null &&
							!paths.has(path) &&
							!snapshotDirectories(snapshot).has(path),
					});
				// A library write starts as text; a retained binary side is a no-op.
				if (merged.content !== null && typeof merged.content !== 'string')
					throw new Error('Text save produced new binary content');
				const changes = new Map<string, string | null>([
					[path, merged.content],
				]);
				if (
					await storage.publish({
						revision: snapshot.state.revision,
						edits: editPatch(snapshot, changes),
					})
				) {
					return Ok({ deleted: merged.content === null });
				}
			}
		});
	}

	function table<const TSchema extends Schema>(name: string, schema: TSchema) {
		if (!validPath(name) || name.includes('/'))
			throw new Error(`Table name must be one filename segment: ${name}`);
		const rowPath = (id: string) => `${name}/${id}.md`;
		return {
			list() {
				return read(async () => {
					const snapshot = await storage.capture(
						(path) =>
							path.startsWith(`${name}/`) &&
							path.endsWith('.md') &&
							!path.slice(name.length + 1).includes('/'),
					);
					const rows: Row<TSchema>[] = [];
					for (const path of [...snapshotPaths(snapshot)].sort()) {
						if (!path.startsWith(`${name}/`) || !path.endsWith('.md')) continue;
						const id = path.slice(name.length + 1, -3);
						if (!validId(id)) continue;
						const content = snapshotContent(snapshot, path);
						if (content !== null) rows.push(readRow(id, content, schema));
					}
					return rows;
				});
			},
			get(id: string) {
				return read(async () => {
					if (!validId(id)) return undefined;
					const content = snapshotContent(
						await storage.capture([rowPath(id)]),
						rowPath(id),
					);
					return content === null ? undefined : readRow(id, content, schema);
				});
			},
			set(
				id: string,
				from: Row<TSchema> | null,
				change: RowChange,
			): Promise<Result<{ sent: Row<TSchema> }, SaveError>> {
				return save(async () => {
					if (!validId(id)) return SaveError.InvalidId({ id });
					if (
						change.body !== undefined &&
						(typeof change.body !== 'string' ||
							change.body.includes('\0') ||
							!change.body.isWellFormed())
					)
						return SaveError.NotText();
					if (from?.issues?.some((issue) => issue.kind === 'not-text'))
						return SaveError.NotText();
					const sent = rowChange(from, change);
					if (sent.error !== null)
						return SaveError.Unparseable({ reason: sent.error.reason });
					const saved = await saveFile(
						rowPath(id),
						from?.text ?? null,
						sent.data.text,
						change.fields !== undefined,
					);
					if (saved.error !== null) return Err(saved.error);
					return Ok({ sent: readRow(id, sent.data.text, schema) });
				});
			},
			delete(
				id: string,
				from: Row<TSchema> | null,
			): Promise<Result<{ deleted: boolean }, SaveError>> {
				const base = from?.text ?? null;
				const notText = from?.issues?.some(
					(issue) => issue.kind === 'not-text',
				);
				return save<{ deleted: boolean }>(async () => {
					if (!validId(id)) return SaveError.InvalidId({ id });
					if (notText) return SaveError.NotText();
					const path = rowPath(id);
					for (;;) {
						const snapshot = await storage.capture([path]);
						const directories = snapshotDirectories(snapshot);
						if (directories.has(path)) return Ok({ deleted: false });
						if (
							snapshotContent(snapshot, path) === null &&
							snapshotPaths(snapshot).has(path)
						)
							return Ok({ deleted: false });
						const merged = await merge(path, {
							base,
							current: snapshotContent(snapshot, path),
							change: null,
						});
						if (merged.content !== null) return Ok({ deleted: false });
						const changes = new Map<string, null>([[path, null]]);
						if (directories.has(`${name}/${id}`))
							changes.set(`${name}/${id}`, null);
						for (const child of snapshotPaths(snapshot))
							if (child.startsWith(`${name}/${id}/`)) changes.set(child, null);
						if (
							await storage.publish({
								revision: snapshot.state.revision,
								edits: editPatch(snapshot, changes),
							})
						)
							return Ok({ deleted: true });
					}
				});
			},
			files(id: string) {
				return files(`${name}/${id}/`, id);
			},
		};
	}

	function files(root = '', rowId?: string) {
		const invalidId = rowId !== undefined && !validId(rowId);
		return {
			list(prefix = '') {
				return read(async () => {
					if (
						invalidId ||
						(prefix !== '' && !validPath(prefix.replace(/\/$/, '')))
					)
						return [];
					const snapshot = await storage.capture([]);
					return [...snapshotPaths(snapshot)]
						.filter(
							(path) =>
								(snapshot.edits.has(path) ||
									snapshot.head.files.get(path)?.mode !== '160000') &&
								path.startsWith(root + prefix),
						)
						.sort()
						.map((path) => path.slice(root.length));
				});
			},
			read(path: string) {
				return read(async () => {
					if (invalidId || !validPath(path)) return undefined;
					const content = snapshotContent(
						await storage.capture([root + path]),
						root + path,
					);
					if (content === null) return undefined;
					const bytes =
						typeof content === 'string' ? encoder.encode(content) : content;
					return { path, content: new Blob([new Uint8Array(bytes)]) };
				});
			},
			async write(
				path: string,
				from: FileContent | null,
				text: string,
			): Promise<Result<void, SaveError>> {
				assertOpen();
				if (invalidId) return SaveError.InvalidId({ id: rowId });
				if (!validPath(path)) return SaveError.InvalidPath({ path });
				const result = await saveFile(root + path, from, text);
				return result.error !== null ? Err(result.error) : Ok(undefined);
			},
			delete(path: string, from: FileContent | null) {
				assertOpen();
				if (invalidId)
					return Promise.resolve(SaveError.InvalidId({ id: rowId }));
				if (!validPath(path))
					return Promise.resolve(SaveError.InvalidPath({ path }));
				return saveFile(root + path, from, null);
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

		/**
		 * Build at most one pending commit. A retry reuses exact C, even if E has
		 * grown since it was published. The network layer must settle C first.
		 */
		async prepareCommit(author: {
			name: string;
			email: string;
			timestamp: number;
		}): Promise<Result<PendingCommit | null, SaveError>> {
			return save(async () => {
				for (;;) {
					const snapshot = await storage.capture([]);
					const { base, head, revision, shallow } = snapshot.state;
					if (!snapshot.state.remoteKnown) return Ok(null);
					if (head !== base) {
						if (head === null)
							throw new StorageFailure(
								'Repository has a confirmed base without a current commit',
							);
						return Ok({ base, head });
					}
					if (snapshot.edits.size === 0) return Ok(null);
					const candidate = await changeSnapshot({
						root: snapshot.head.root,
						edits: snapshot.edits,
						read: async (oid) => snapshotObject(snapshot, oid),
					});
					const commit: GitObject = {
						type: 'commit',
						bytes: writeCommit({
							tree: candidate.tree,
							parents: head === null ? [] : [head],
							author,
							message: 'Save repository changes\n',
						}),
					};
					const oid = await hashObject(commit);
					candidate.objects.set(oid, commit);
					if (
						await storage.publish({
							revision,
							objects: candidate.objects,
							refs: { base, head: oid, shallow },
							edits: new Map(
								[...snapshot.edits.keys()].map((path) => [path, undefined]),
							),
						})
					)
						return Ok({ base, head: oid });
				}
			});
		},

		close() {
			closed = true;
			storage.close();
		},
	};
}

export type LocalRepository = Awaited<ReturnType<typeof openRepository>>;
