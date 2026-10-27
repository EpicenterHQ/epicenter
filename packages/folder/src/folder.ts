/**
 * An edit shows what was typed; the queue carries it; the folder shows what landed.
 * Opening reads listed text files. Reads and writes take turns in one queue, so
 * an update reads storage at its turn before composing its patch. The copy
 * changes only after a put lands or a read observes another writer.
 */
import type { TSchema as Schema, Static } from 'typebox';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { OpenFolderError } from './errors.js';
import { applyPatch, declaredKeysOf, type RowPatch } from './patch.js';
import { invalidTable } from './paths.js';
import { ReadError, SaveError } from './shared/errors.js';
import {
	type Issue as MarkdownIssue,
	readMarkdown,
} from './shared/markdown-codec.js';
import { merge, sameContent } from './shared/merge.js';
import type { Fetched, FolderHost, Listed } from './storage.js';
import { type WriteError, WriteRefusal } from './write-refusal.js';

/** A file's contents: text when the bytes are UTF-8, bytes otherwise. */
export type Data = string | Uint8Array;

/** One listed file, as it is on disk. */
export type FolderFile = {
	readonly path: string;
	readonly mime: string;
	/**
	 * What is on disk: text, or bytes when a kept file is not UTF-8.
	 * `undefined` for a file the folder copy does not keep (see `read`), and for a
	 * kept file whose read failed (see `readError`).
	 */
	readonly data: Data | undefined;
	/** The latest read of this file failed; `data` keeps what was read before, if anything. */
	readonly readError: ReadError | null;
};
export type RowIssue =
	| MarkdownIssue
	| {
			readonly kind: 'unreadable';
			readonly message: string;
			readonly path: readonly [];
			readonly error: ReadError;
	  };
/** A row as it is on disk: valid, or with the issues that keep it from reading as one. */
export type Row<S extends Schema = Schema> = {
	readonly id: string;
	readonly path: string;
} & RowReading<S>;
/** Fields and the body to set on a row's file as it is when the save runs; a field set to `undefined` is removed. */
export type Patch<S extends Schema = Schema> = {
	readonly fields?: Partial<Static<S>>;
	readonly body?: string;
};
/** Answers once this or a newer merged write landed and the copy shows it, or why it did not land. */
export type Saved = Promise<Result<void, WriteError>>;
/** A folder's tables: each key is a top-level directory of `<id>.md` rows read through its schema. */
export type Tables = Record<string, Schema>;

export type Table<S extends Schema = Schema> = {
	/** Every row, sorted by id; an unchanged row keeps its object, and `row(id)` answers the same objects. */
	rows(): readonly Row<S>[];
	row(id: string): Row<S> | undefined;
	/** Make the row's file; refuses with `Exists` when a file is there. */
	create(id: string, init: { fields: Static<S>; body?: string }): Saved;
	/** Set what `patch` names on the row's file as it is when the save runs. */
	update(id: string, patch: Patch<S>): Saved;
	delete(id: string): Saved;
};
export type Folder<T extends Tables = Tables> = {
	/** One notice after each change to what the folder shows. Answers unsubscribe. */
	subscribe(onChange: () => void): () => void;
	/** Every listed file, sorted by path; an unchanged file keeps its object. */
	files(): readonly FolderFile[];
	file(path: string): FolderFile | undefined;
	/** Whether a write is waiting or being saved. */
	saving(): boolean;
	/** Wait until the queue is quiet, including turns added while waiting. */
	idle(): Promise<void>;
	/** A file's bytes from storage, `null` when no file is there; for files the folder copy does not keep. */
	read(path: string): Promise<Result<Uint8Array | null, ReadError>>;
	/** Replace the whole file, or merge it at its turn against the exact base it was edited from. */
	write(path: string, data: Data, options?: { base?: Data | null }): Saved;
	/** Set fields and the body on a Markdown file at any path; `schema` orders its declared keys first. */
	update(
		path: string,
		patch: { fields?: Record<string, unknown>; body?: string },
		options?: { schema?: Schema },
	): Saved;
	/** Copy the latest source to an empty destination, then remove the source. */
	move(from: string, to: string): Saved;
	delete(path: string): Saved;
	readonly tables: { readonly [K in keyof T]: Table<T[K]> };
	/** Relist and read files that moved. */
	refresh(): Promise<void>;
	/** Refuse new writes, drain queued work, then release storage. */
	close(): Promise<void>;
};

export type OpenOptions<T extends Tables> = {
	/** Each key is a top-level directory of `<id>.md` rows read through its schema. */
	readonly tables: T;
};
export type Opened<T extends Tables> = Promise<
	Result<Folder<T>, OpenFolderError>
>;

type Entry = {
	value: FolderFile;
	stamp: string | undefined;
};
type Op =
	| { kind: 'write'; data: Data | null; base?: Data | null }
	| { kind: 'move'; to: string }
	| { kind: 'create' | 'update'; patch: RowPatch; keys: readonly string[] };
type PendingWrite = {
	path: string;
	op: Op;
	started: boolean;
};
type WaitingWrite = { turn: PendingWrite; saved: Saved };

/**
 * A waiting write absorbs a newer one for the same file when its based text
 * follows the waiting text: whole-file writes keep the newest data and the
 * oldest supplied base; two updates through the same schema combine patches.
 * Anything else waits its own turn.
 */
function absorb(waiting: Op, next: Op): Op | undefined {
	if (waiting.kind === 'write' && next.kind === 'write') {
		if (next.base === undefined) return next;
		if (waiting.base === undefined || !sameContent(waiting.data, next.base))
			return undefined;
		return { ...next, base: waiting.base };
	}
	if (
		waiting.kind === 'update' &&
		next.kind === 'update' &&
		waiting.keys.length === next.keys.length &&
		waiting.keys.every((key, index) => key === next.keys[index])
	)
		return {
			kind: 'update',
			keys: waiting.keys,
			patch: {
				fields: { ...waiting.patch.fields, ...next.patch.fields },
				body: next.patch.body ?? waiting.patch.body,
			},
		};
	return undefined;
}

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();
const keptExtensions = new Set([
	'md',
	'markdown',
	'txt',
	'json',
	'jsonl',
	'yaml',
	'yml',
	'toml',
	'csv',
	'tsv',
	'svg',
	'html',
	'htm',
	'css',
	'js',
	'mjs',
	'ts',
	'xml',
	'ini',
	'log',
]);

export async function createFolder<const T extends Tables>(
	host: FolderHost,
	{ tables }: OpenOptions<T>,
): Opened<T> {
	const invalid =
		invalidTable(tables) ??
		Object.keys(tables).find((name) => !name.isWellFormed());
	if (invalid !== undefined) {
		host.close?.();
		return OpenFolderError.InvalidTable({ table: invalid });
	}
	const landed = new Map<string, Entry>();
	const listeners = new Set<() => void>();
	let filesSnapshot: readonly FolderFile[] = [];
	let filesDirty = false;
	let changed = false;
	let savingSnapshot = false;
	let pendingWrites = 0;
	let phase: 'open' | 'closing' | 'closed' = 'open';
	let lastTurn = Promise.resolve();
	const waitingWrites = new Map<string, WaitingWrite>();
	const failedBasedWrites = new Map<
		string,
		{ data: Data; base: Data | null }
	>();
	let closing: Promise<void> | undefined;
	const look = { queued: false, relist: false, paths: new Set<string>() };

	function takeTurn<TValue>(work: () => Promise<TValue>): Promise<TValue> {
		const next = lastTurn.then(work);
		lastTurn = next.then(
			() => {},
			() => {},
		);
		return next;
	}

	function publish() {
		const saving = pendingWrites > 0;
		if (saving !== savingSnapshot) {
			savingSnapshot = saving;
			changed = true;
		}
		if (!changed) return;
		changed = false;
		if (filesDirty) {
			filesDirty = false;
			filesSnapshot = [...landed.values()]
				.map((entry) => entry.value)
				.sort((a, b) => compare(a.path, b.path));
		}
		for (const listener of [...listeners]) listener();
	}

	function set(path: string, entry: Entry | undefined) {
		const before = landed.get(path);
		if (entry === undefined) {
			if (before === undefined) return;
			landed.delete(path);
		} else {
			if (before?.value === entry.value) {
				landed.set(path, entry);
				return;
			}
			landed.set(path, entry);
		}
		changed = true;
		filesDirty = true;
	}

	function applyRead(path: string, result: Result<Fetched, ReadError>) {
		const before = landed.get(path);
		if (result.error !== null) {
			set(path, {
				value: {
					path,
					mime: mimeOf(path),
					data: before?.value.data,
					readError: result.error,
				},
				stamp: before?.stamp,
			});
			return;
		}
		const fetched = result.data;
		if (fetched === null) return set(path, undefined);
		if (!holdsText(path)) {
			if (before?.stamp === fetched.stamp && before.value.readError === null)
				return;
			return set(path, mediaEntry(path, fetched));
		}
		const data = decode(fetched.bytes);
		if (
			before?.value.readError === null &&
			before.value.data !== undefined &&
			sameData(before.value.data, data)
		) {
			landed.set(path, { ...before, stamp: fetched.stamp });
			return;
		}
		set(path, {
			value: {
				path,
				mime: mimeOf(path),
				data,
				readError: null,
			},
			stamp: fetched.stamp,
		});
	}

	async function readPaths(paths: readonly string[]): Promise<boolean> {
		if (paths.length === 0 || phase === 'closed') return false;
		const results = await host
			.read(paths)
			.catch(
				(cause: unknown) =>
					new Map(
						paths.map((path) => [path, ReadError.StorageFailed({ cause })]),
					),
			);
		let failed = false;
		for (const path of paths) {
			const result = results.get(path);
			if (result === undefined || result.error !== null) failed = true;
			if (result !== undefined) applyRead(path, result);
		}
		publish();
		return failed;
	}

	async function rereadAfterChanged(path: string) {
		const results = await host
			.read([path])
			.catch(
				(cause: unknown) =>
					new Map([[path, ReadError.StorageFailed({ cause })]]),
			);
		const fresh = results.get(path);
		if (fresh !== undefined) {
			applyRead(path, fresh);
			publish();
		}
		return fresh;
	}

	async function relist(): Promise<ReadError | null> {
		if (phase === 'closed') return null;
		const { data: listed, error } = await host
			.list()
			.catch((cause: unknown) => ReadError.StorageFailed({ cause }));
		if (error !== null) return error;
		const toRead: string[] = [];
		const media = new Map<string, Entry>();
		for (const [path, stat] of listed) {
			const entry = landed.get(path);
			if (!holdsText(path)) {
				if (
					entry === undefined ||
					entry.stamp !== stat.stamp ||
					entry.value.readError !== null
				)
					media.set(path, mediaEntry(path, stat));
				continue;
			}
			if (
				entry === undefined ||
				entry.stamp !== stat.stamp ||
				entry.value.readError !== null
			)
				toRead.push(path);
		}
		const results =
			toRead.length === 0
				? new Map<string, Result<Fetched, ReadError>>()
				: await host
						.read(toRead)
						.catch(
							(cause: unknown) =>
								new Map(
									toRead.map((path) => [
										path,
										ReadError.StorageFailed({ cause }),
									]),
								),
						);
		for (const path of landed.keys())
			if (!listed.has(path)) set(path, undefined);
		for (const [path, entry] of media) set(path, entry);
		for (const path of toRead) {
			const result = results.get(path);
			applyRead(
				path,
				result ??
					ReadError.StorageFailed({ cause: `No read answered ${path}` }),
			);
		}
		publish();
		return null;
	}

	function requestLook(path?: string) {
		if (phase !== 'open') return;
		// A held text file rereads alone; reading media just to learn it changed
		// would fetch its bytes, so media and unknown paths relist.
		if (path === undefined || !landed.has(path) || !holdsText(path))
			look.relist = true;
		else look.paths.add(path);
		if (look.queued) return;
		look.queued = true;
		void takeTurn(async () => {
			look.queued = false;
			const paths = [...look.paths];
			const shouldRelist = look.relist;
			look.paths.clear();
			look.relist = false;
			const failed = await readPaths(paths);
			if (shouldRelist || failed) await relist();
		});
	}

	function enqueue(path: string, op: Op): Saved {
		if (phase !== 'open') return Promise.resolve(WriteRefusal.Closed());
		if (op.kind === 'move') waitingWrites.delete(op.to);
		const waiting = waitingWrites.get(path);
		const absorbed =
			waiting === undefined || waiting.turn.started
				? undefined
				: absorb(waiting.turn.op, op);
		if (waiting !== undefined && absorbed !== undefined) {
			waiting.turn.op = absorbed;
			return waiting.saved;
		}
		pendingWrites++;
		publish();
		const turn: PendingWrite = { path, op, started: false };
		const saved = takeTurn(async (): Promise<Result<void, WriteError>> => {
			turn.started = true;
			if (waitingWrites.get(path)?.turn === turn) waitingWrites.delete(path);
			const op = turn.op;
			if (op.kind === 'write' && op.data !== null && op.base !== undefined) {
				const failed = failedBasedWrites.get(path);
				if (failed !== undefined && sameContent(op.base, failed.data))
					op.base = failed.base;
			}
			try {
				const result = await send(path, op);
				if (result.error === null) failedBasedWrites.delete(path);
				else if (
					op.kind === 'write' &&
					op.data !== null &&
					op.base !== undefined
				)
					failedBasedWrites.set(path, { data: op.data, base: op.base });
				return result;
			} catch (cause) {
				if (op.kind === 'write' && op.data !== null && op.base !== undefined)
					failedBasedWrites.set(path, { data: op.data, base: op.base });
				return SaveError.StorageFailed({ cause });
			} finally {
				pendingWrites--;
				publish();
			}
		});
		waitingWrites.set(path, { turn, saved });
		return saved;
	}

	function landedPut(path: string, next: Data | null, stamp: string | null) {
		if (stamp === null) set(path, undefined);
		else {
			const data =
				holdsText(path) && next !== null
					? typeof next === 'string'
						? next
						: decode(next)
					: undefined;
			const before = landed.get(path)?.value;
			const value =
				before?.data !== undefined &&
				data !== undefined &&
				before.readError === null &&
				sameData(before.data, data)
					? before
					: { path, mime: mimeOf(path), data, readError: null };
			set(path, { value, stamp });
		}
		publish();
	}

	async function sendMove(from: string, to: string): Saved {
		if (from === to) return WriteRefusal.Exists({ path: to });
		const results = await host.read([from]);
		const fresh = results.get(from);
		if (fresh === undefined)
			return SaveError.StorageFailed({ cause: `No read answered ${from}` });
		if (fresh.error !== null)
			return SaveError.StorageFailed({ cause: fresh.error });
		applyRead(from, fresh);
		publish();
		if (fresh.data === null) return WriteRefusal.NothingToMove({ path: from });
		const bytes = fresh.data.bytes;
		const copied = await host.put(to, bytes, 'absent');
		if (copied.error?.name === 'Changed') {
			const destination = await rereadAfterChanged(to);
			if (
				destination === undefined ||
				destination.error !== null ||
				destination.data === null ||
				!sameData(destination.data.bytes, bytes)
			)
				return WriteRefusal.Exists({ path: to });
		} else if (copied.error !== null) return Err(copied.error);
		else landedPut(to, bytes, copied.data?.stamp ?? null);
		const removed = await host.put(from, null, bytes);
		if (removed.error !== null) {
			const source = await rereadAfterChanged(from);
			if (
				removed.error.name === 'Changed' &&
				source?.error === null &&
				source.data === null
			)
				return Ok(undefined);
			return SaveError.MoveIncomplete({ from, to, cause: removed.error });
		}
		landedPut(from, null, null);
		return Ok(undefined);
	}

	async function send(path: string, op: Op): Saved {
		if (op.kind === 'move') return sendMove(path, op.to);
		if (op.kind === 'write' && op.base !== undefined && op.data !== null) {
			const change =
				typeof op.data === 'string' ? op.data.toWellFormed() : op.data;
			for (let attempt = 0; ; attempt++) {
				const results = await host.read([path]);
				const fresh = results.get(path);
				if (fresh === undefined)
					return SaveError.StorageFailed({ cause: `No read answered ${path}` });
				if (fresh.error !== null)
					return SaveError.StorageFailed({ cause: fresh.error });
				applyRead(path, fresh);
				publish();
				const current = fresh.data?.bytes ?? null;
				const next = sameContent(current, op.base)
					? change
					: (await merge(path, { base: op.base, current, change })).content;
				const put = await host.put(path, encode(next), current ?? 'absent');
				if (put.error?.name === 'Changed') {
					if (attempt < 3) continue;
					return SaveError.StorageFailed({ cause: put.error });
				}
				if (put.error !== null) return Err(put.error);
				landedPut(path, next, put.data?.stamp ?? null);
				return Ok(undefined);
			}
		}
		let next: Data | null;
		let expect: 'absent' | Uint8Array | undefined;
		switch (op.kind) {
			case 'write':
				next = op.data;
				break;
			case 'create':
				expect = 'absent';
				{
					const patched = applyPatch(null, op.patch, op.keys);
					if (patched.error !== null)
						return SaveError.Unparseable({ reason: patched.error.reason });
					next = patched.data === 'unchanged' ? '' : patched.data;
				}
				break;
			case 'update':
				for (let attempt = 0; ; attempt++) {
					const results = await host.read([path]);
					const fresh = results.get(path);
					if (fresh === undefined)
						return SaveError.StorageFailed({
							cause: `No read answered ${path}`,
						});
					if (fresh.error !== null)
						return SaveError.StorageFailed({ cause: fresh.error });
					applyRead(path, fresh);
					publish();
					if (fresh.data === null)
						return WriteRefusal.NothingToUpdate({ path });
					const current = decode(fresh.data.bytes);
					if (current instanceof Uint8Array) return SaveError.NotText();
					const patched = applyPatch(current, op.patch, op.keys);
					if (patched.error !== null)
						return SaveError.Unparseable({ reason: patched.error.reason });
					if (patched.data === 'unchanged') return Ok(undefined);
					const updated = patched.data.toWellFormed();
					const put = await host.put(
						path,
						encode(updated),
						attempt < 3 ? fresh.data.bytes : undefined,
					);
					if (put.error?.name === 'Changed') {
						if (attempt < 3) continue;
						return SaveError.StorageFailed({ cause: put.error });
					}
					if (put.error !== null) return Err(put.error);
					landedPut(path, updated, put.data?.stamp ?? null);
					return Ok(undefined);
				}
		}
		// Encoding replaces lone surrogates on disk; the copy shows what landed.
		if (typeof next === 'string') next = next.toWellFormed();
		const sent = encode(next);
		const put = await host.put(path, sent, expect);
		if (put.error?.name === 'Changed') {
			if (op.kind === 'create') {
				// A resent create whose first run landed reads back its own bytes.
				const current = await rereadAfterChanged(path);
				if (
					current?.error === null &&
					current.data !== null &&
					sent !== null &&
					sameData(current.data.bytes, sent)
				)
					return Ok(undefined);
				return WriteRefusal.Exists({ path });
			}
			return SaveError.StorageFailed({ cause: put.error });
		}
		if (put.error !== null) return Err(put.error);
		landedPut(path, next, put.data?.stamp ?? null);
		return Ok(undefined);
	}

	function table<S extends Schema>(directory: string, schema: S): Table<S> {
		const prefix = `${directory}/`;
		const keys = declaredKeysOf(schema);
		const pathOf = (id: string) => `${prefix}${id}.md`;
		const idOf = (path: string) => {
			if (!path.startsWith(prefix) || !path.endsWith('.md')) return undefined;
			const id = path.slice(prefix.length, -3);
			return id === '' || id.includes('/') ? undefined : id;
		};
		const cache = new WeakMap<FolderFile, Row<S>>();
		let fromFiles: readonly FolderFile[] | undefined;
		let rowsSnapshot: readonly Row<S>[] = [];
		const cachedRow = (id: string, file: FolderFile) => {
			let row = cache.get(file);
			if (row === undefined) {
				row = rowOf(id, file, schema);
				cache.set(file, row);
			}
			return row;
		};
		return {
			rows() {
				if (fromFiles === filesSnapshot) return rowsSnapshot;
				fromFiles = filesSnapshot;
				const rows = filesSnapshot
					.flatMap((file) => {
						const id = idOf(file.path);
						return id === undefined ? [] : [cachedRow(id, file)];
					})
					.sort((a, b) => compare(a.id, b.id));
				if (
					rows.length !== rowsSnapshot.length ||
					rows.some((row, index) => row !== rowsSnapshot[index])
				)
					rowsSnapshot = rows;
				return rowsSnapshot;
			},
			row(id) {
				if (invalidId(id)) return undefined;
				const file = landed.get(pathOf(id))?.value;
				return file === undefined ? undefined : cachedRow(id, file);
			},
			create(id, init) {
				if (invalidId(id)) return Promise.resolve(SaveError.InvalidId({ id }));
				return enqueue(pathOf(id), {
					kind: 'create',
					patch: {
						// SAFETY: table frontmatter is a mapping.
						fields: init.fields as Record<string, unknown>,
						body: init.body ?? '',
					},
					keys,
				});
			},
			update(id, patch) {
				if (invalidId(id)) return Promise.resolve(SaveError.InvalidId({ id }));
				// SAFETY: patch fields are a subset of the table's frontmatter mapping.
				return folder.update(pathOf(id), patch as RowPatch, { schema });
			},
			delete(id) {
				if (invalidId(id)) return Promise.resolve(SaveError.InvalidId({ id }));
				return enqueue(pathOf(id), { kind: 'write', data: null });
			},
		};
	}

	const tableEntries = Object.entries(tables).map(([name, schema]) => [
		name,
		table(name, schema),
	]);
	const stopHints = host.hints?.((paths) => {
		if (phase === 'closed') return;
		if (paths === null) requestLook();
		else for (const path of paths) requestLook(path);
	});
	const folder: Folder<T> = {
		subscribe(onChange) {
			listeners.add(onChange);
			return () => listeners.delete(onChange);
		},
		files: () => filesSnapshot,
		file: (path) => landed.get(path)?.value,
		saving: () => savingSnapshot,
		async idle() {
			for (;;) {
				const turn = lastTurn;
				await turn;
				if (turn === lastTurn) return;
			}
		},
		async read(path) {
			const results = await host
				.read([path])
				.catch(
					(cause: unknown) =>
						new Map([[path, ReadError.StorageFailed({ cause })]]),
				);
			const result = results.get(path);
			if (result === undefined)
				return ReadError.StorageFailed({ cause: `No read answered ${path}` });
			return result.error !== null
				? Err(result.error)
				: Ok(result.data?.bytes ?? null);
		},
		write: (path, data, options) =>
			enqueue(path, { kind: 'write', data, base: options?.base }),
		update: (path, patch, options) =>
			enqueue(path, {
				kind: 'update',
				patch,
				keys: declaredKeysOf(options?.schema),
			}),
		delete: (path) => enqueue(path, { kind: 'write', data: null }),
		move: (from, to) => enqueue(from, { kind: 'move', to }),
		// SAFETY: one table was built for each key in T.
		tables: Object.fromEntries(tableEntries) as Folder<T>['tables'],
		async refresh() {
			if (phase !== 'open') return;
			await takeTurn(relist);
		},
		close() {
			closing ??= (async () => {
				phase = 'closing';
				stopHints?.();
				await lastTurn;
				phase = 'closed';
				host.close?.();
			})();
			return closing;
		},
	};
	const first = await takeTurn(relist);
	if (first !== null) {
		phase = 'closed';
		stopHints?.();
		host.close?.();
		return OpenFolderError.Unavailable({ cause: first });
	}
	return Ok(folder);
}

function invalidId(id: string) {
	return id === '' || id.includes('/');
}
function compare(a: string, b: string) {
	return a < b ? -1 : a > b ? 1 : 0;
}
function sameData(a: Data, b: Data) {
	if (a === b) return true;
	if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array)) return false;
	return a.length === b.length && a.every((value, index) => value === b[index]);
}
/** What a row's text reads as through its schema: the fields, body, and any issues. */
export type RowReading<S extends Schema = Schema> =
	| { readonly fields: Static<S>; readonly body: string; readonly issues: null }
	| {
			readonly fields: Record<string, unknown> | undefined;
			readonly body: string | undefined;
			readonly issues: readonly [RowIssue, ...RowIssue[]];
	  };

/** A readable sentence for one row issue. */
export function describeIssue(issue: RowIssue): string {
	const field = issue.path.length > 0 ? issue.path.join('.') : undefined;
	const place = [
		'line' in issue && issue.line !== undefined
			? `Line ${issue.line}`
			: undefined,
		field,
	].filter((part) => part !== undefined);
	return place.length === 0
		? issue.message
		: `${place.join(': ')}: ${issue.message}`;
}

/** All row issues in reading order. */
export function describeIssues(issues: readonly RowIssue[]): string {
	return issues.map(describeIssue).join(' ');
}

/**
 * Read row text through `schema`, as the folder copy reads a saved row. For a
 * repair view that checks what is typed before it saves.
 */
export function readRow<S extends Schema>(
	text: Data,
	schema: S,
): RowReading<S> {
	const value = readMarkdown(text, schema);
	if (value.issues === null)
		return { fields: value.fields, body: value.body, issues: null };
	const [first, ...rest] = value.issues;
	return {
		fields: value.fields,
		body: value.body,
		issues:
			first === undefined
				? [{ kind: 'frontmatter', message: 'The row did not read', path: [] }]
				: [first, ...rest],
	};
}

function rowOf<S extends Schema>(
	id: string,
	file: FolderFile,
	schema: S,
): Row<S> {
	const { path } = file;
	if (file.data === undefined) {
		// SAFETY: a kept row without data has a read error.
		const error = file.readError as ReadError;
		return {
			id,
			path,
			fields: undefined,
			body: undefined,
			issues: [{ kind: 'unreadable', message: error.message, path: [], error }],
		};
	}
	return { id, path, ...readRow(file.data, schema) };
}
function mediaEntry(path: string, stat: Listed): Entry {
	return {
		value: { path, mime: mimeOf(path), data: undefined, readError: null },
		stamp: stat.stamp,
	};
}
function decode(bytes: Uint8Array): Data {
	try {
		return decoder.decode(bytes);
	} catch {
		return bytes;
	}
}
function encode(data: Data | null): Uint8Array | null {
	return data === null
		? null
		: typeof data === 'string'
			? encoder.encode(data)
			: data;
}
const MIME = new Map([
	['md', 'text/markdown'],
	['txt', 'text/plain'],
	['json', 'application/json'],
	['png', 'image/png'],
	['jpg', 'image/jpeg'],
	['jpeg', 'image/jpeg'],
	['gif', 'image/gif'],
	['webp', 'image/webp'],
	['svg', 'image/svg+xml'],
	['mp3', 'audio/mpeg'],
	['m4a', 'audio/mp4'],
	['wav', 'audio/wav'],
	['webm', 'audio/webm'],
	['ogg', 'audio/ogg'],
	['mp4', 'video/mp4'],
	['mov', 'video/quicktime'],
	['pdf', 'application/pdf'],
	['zip', 'application/zip'],
]);
function mimeOf(path: string): string {
	const segment = path.slice(path.lastIndexOf('/') + 1);
	const dot = segment.lastIndexOf('.');
	return (
		MIME.get(dot === -1 ? '' : segment.slice(dot + 1).toLowerCase()) ??
		'application/octet-stream'
	);
}
/** Whether the folder copy keeps a file's contents: text extensions, and names with no extension or only a leading dot. */
function holdsText(path: string): boolean {
	const segment = path.slice(path.lastIndexOf('/') + 1);
	const dot = segment.lastIndexOf('.');
	return dot <= 0 || keptExtensions.has(segment.slice(dot + 1).toLowerCase());
}
