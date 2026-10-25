/**
 * An opened folder: a mirror of what landed on disk, and the one way to
 * change it.
 *
 * Opening lists the folder and reads every text file, so every read after
 * that is synchronous and complete. Media (images, audio, video, PDFs, and
 * archives) is listed but not kept; `read` fetches its bytes when a view
 * needs them.
 *
 * The mirror never runs ahead of the disk. A write goes down to storage, and
 * the mirror changes when the write's answer comes back, or when a read sees
 * another writer's change. A failed write therefore needs no rollback: the
 * mirror still shows the disk, and `onSaveFailed` says what was not saved.
 * The one thing allowed to run ahead of the disk is what a person is typing,
 * which an editor keeps in a draft (`@epicenter/svelte`, `@epicenter/react`).
 *
 * Each path has one write in flight at a time. The first write after a quiet
 * second goes at once; writes made while one is in flight, or within that
 * second, wait and merge into one, so typing saves about once a second. A
 * table's `update` sets fields and the body on the file as it is on disk when
 * the save runs, as an SQL `UPDATE` does: what it names wins, everything else
 * is kept, and the row is written in the canonical form (`patch.ts`). If the
 * file changed under the save, the folder rereads it and applies the update
 * again, up to three times.
 *
 * Reads and write answers are ordered per path: a read that overlapped a
 * write to its path is dropped and asked again, so an older read never puts
 * an older file back.
 */
import type { TSchema as Schema, Static } from 'typebox';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { ReadError } from '../shared/errors.js';
import {
	type Issue as MarkdownIssue,
	readMarkdown,
} from '../shared/markdown-codec.js';
import { EditError, OpenError, SaveError } from './errors.js';
import { applyPatch, declaredKeysOf, type RowPatch } from './patch.js';
import type { Expected, Fetched, FolderHost, Listed } from './storage.js';
import { createStore, type Store } from './store.js';

/** A file's contents: text when the bytes are UTF-8, bytes otherwise. */
export type Data = string | Uint8Array;

/** One listed file, as it is on disk. */
export type FileValue = {
	readonly path: string;
	readonly mime: string;
	/**
	 * What is on disk: text, or bytes when a file that should be text is not
	 * UTF-8. `undefined` for media, which is not kept (see `read`), and for a
	 * file whose read failed (see `readError`).
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
} & (
	| {
			readonly fields: Static<S>;
			readonly body: string;
			readonly issues: null;
	  }
	| {
			/** Raw frontmatter when it parsed but failed the schema. */
			readonly fields: Record<string, unknown> | undefined;
			readonly body: string | undefined;
			readonly issues: readonly [RowIssue, ...RowIssue[]];
	  }
);

/** Fields and the body to set on a row's file as it is when the save runs. */
export type Patch<S extends Schema = Schema> = {
	readonly fields?: Partial<Static<S>>;
	readonly body?: string;
};

export type Saved = Promise<Result<void, EditError>>;

/** A write that did not land. The mirror already shows the disk. */
export type SaveFailure = {
	readonly path: string;
	/** What the write tried to put there: text or bytes, `null` for a delete, `undefined` when it could not be composed. */
	readonly attempted: Data | null | undefined;
	readonly error: EditError;
};

/** A folder's tables: each key is a top-level directory of `<id>.md` rows read through its schema. */
export type Tables = Record<string, Schema>;

export type Table<S extends Schema = Schema> = {
	/** Every row in the table, in listing order; an unchanged row keeps its object. */
	readonly rows: Store<readonly Row<S>[]>;
	row(id: string): Row<S> | undefined;
	/** Make the row's file; refuses with `Exists` when a file is there. */
	create(id: string, init: { fields: Static<S>; body?: string }): Saved;
	/** Set what `patch` names on the row's file as it is when the save runs. */
	update(id: string, patch: Patch<S>): Saved;
	delete(id: string): Saved;
};

export type Folder<T extends Tables = Tables> = {
	/** Every listed file, in listing order; an unchanged file keeps its object. */
	readonly files: Store<readonly FileValue[]>;
	file(path: string): FileValue | undefined;
	/** A file's bytes from storage, `null` when no file is there; for media, which the mirror does not keep. */
	read(path: string): Promise<Result<Uint8Array | null, ReadError>>;
	/** Replace the whole file. */
	write(path: string, data: Data): Saved;
	delete(path: string): Saved;
	readonly tables: { readonly [K in keyof T]: Table<T[K]> };
	/** Whether a write is waiting or in flight. */
	readonly saving: Store<boolean>;
	/** Called once for each write that did not land. */
	onSaveFailed(listener: (failure: SaveFailure) => void): () => void;
	/** Look at storage again, and send waiting writes now: on focus, visibility, wake, and before the page hides. */
	checkpoint(): void;
	/** Refuse new writes, send what waits, wait for every write and read, then release storage. */
	close(): Promise<void>;
};

type Entry = {
	readonly value: FileValue;
	/** Content identity, for conditional saves; `null` when nothing was read. */
	readonly version: string | null;
	/** The listing's change token when this was read or landed. */
	readonly token: string | undefined;
};

type Op =
	| { readonly kind: 'write'; readonly data: Data | null }
	| {
			readonly kind: 'update' | 'create';
			readonly patch: RowPatch;
			readonly keys: readonly string[];
	  };

type Lane = {
	waiting: {
		op: Op;
		resolves: ((result: Result<void, EditError>) => void)[];
	} | null;
	sending: boolean;
	/** Bumped when a write to this path lands, so reads that overlapped it are dropped. */
	epoch: number;
	lastSent: number;
	timer: ReturnType<typeof setTimeout> | undefined;
	/** A read was dropped or a hint arrived while a write was in flight: read once it lands. */
	reread: boolean;
};

const ATTEMPTS = 3;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

/**
 * Open a folder over `host`: list it and read every text file, then answer
 * the folder. A first listing that fails is a refusal to open.
 */
export async function createFolder<const T extends Tables>(
	host: FolderHost,
	{ tables, throttleMs = 1000 }: { tables: T; throttleMs?: number },
): Promise<Result<Folder<T>, OpenError>> {
	const mirror = new Map<string, Entry>();
	const lanes = new Map<string, Lane>();
	const failureListeners = new Set<(failure: SaveFailure) => void>();
	let accepting = true;
	let released = false;

	// ---- what changed, and who hears about it --------------------------------

	const changed = new Set<string>();
	let filesSnapshot: readonly FileValue[] = [];
	const files = createStore(() => filesSnapshot);
	let savingNow = false;
	const saving = createStore(() => savingNow);
	const tableViews: TableView[] = [];

	/** Publish everything changed since the last commit, once. */
	function commit() {
		const busy = [...lanes.values()].some(
			(lane) => lane.sending || lane.waiting !== null,
		);
		if (busy !== savingNow) {
			savingNow = busy;
			saving.notify();
		}
		if (changed.size === 0) return;
		const paths = [...changed];
		changed.clear();
		filesSnapshot = [...mirror.values()].map((entry) => entry.value);
		const touched = tableViews.filter((view) =>
			paths.some((path) => view.owns(path)),
		);
		for (const view of touched) view.refresh();
		files.notify();
		for (const view of touched) view.notify();
	}

	function set(path: string, entry: Entry | undefined) {
		const before = mirror.get(path);
		if (entry === undefined) {
			if (before === undefined) return;
			mirror.delete(path);
		} else mirror.set(path, entry);
		changed.add(path);
	}

	/** Apply a read of `path`: what storage has there, or that the read failed. */
	function applyRead(path: string, result: Result<Fetched, ReadError>) {
		const before = mirror.get(path);
		if (result.error !== null) {
			set(path, {
				value: {
					path,
					mime: mimeOf(path),
					data: before?.value.data,
					readError: result.error,
				},
				version: before?.version ?? null,
				token: before?.token,
			});
			return;
		}
		const fetched = result.data;
		if (fetched === null) return set(path, undefined);
		if (before?.version === fetched.version && before.value.readError === null)
			return set(path, { ...before, token: fetched.token });
		set(path, {
			value: {
				path,
				mime: mimeOf(path),
				data: decode(fetched.bytes),
				readError: null,
			},
			version: fetched.version,
			token: fetched.token,
		});
	}

	// ---- reads -----------------------------------------------------------------

	let active = 0;
	let idleWaiters: (() => void)[] = [];
	const quiet = () =>
		active === 0 &&
		[...lanes.values()].every((lane) => !lane.sending && lane.waiting === null);
	function settle() {
		if (!quiet()) return;
		const waiting = idleWaiters;
		idleWaiters = [];
		for (const resolve of waiting) resolve();
	}
	const idle = () =>
		quiet()
			? Promise.resolve()
			: new Promise<void>((resolve) => idleWaiters.push(resolve));

	/** Read `paths` and apply what came back, skipping any a write overlapped. */
	async function readPaths(paths: readonly string[]) {
		if (paths.length === 0 || released) return;
		active++;
		const epochs = new Map(paths.map((path) => [path, lanes.get(path)?.epoch]));
		try {
			const results = await host.read(paths).catch((cause: unknown) => {
				const failed = ReadError.StorageFailed({ cause });
				return new Map(paths.map((path) => [path, failed]));
			});
			for (const path of paths) {
				const lane = lanes.get(path);
				const result = results.get(path);
				if (
					lane?.sending ||
					lane?.epoch !== epochs.get(path) ||
					result === undefined
				) {
					if (lane !== undefined) lane.reread = true;
					continue;
				}
				applyRead(path, result);
			}
			commit();
		} finally {
			active--;
			settle();
		}
	}

	/** List storage again, read what is new or moved, and drop what is gone. */
	async function relist(): Promise<ReadError | null> {
		if (released) return null;
		active++;
		try {
			const { data: listed, error } = await host.list();
			if (error !== null) return error;
			const toRead: string[] = [];
			for (const [path, stat] of listed) {
				if (lanes.get(path)?.sending) continue;
				const entry = mirror.get(path);
				if (!kept(path)) {
					if (entry === undefined || entry.token !== stat.token)
						set(path, mediaEntry(path, stat));
					continue;
				}
				if (
					entry === undefined ||
					entry.token !== stat.token ||
					entry.value.readError !== null
				)
					toRead.push(path);
			}
			for (const path of [...mirror.keys()])
				if (!listed.has(path) && !lanes.get(path)?.sending)
					set(path, undefined);
			commit();
			await readPaths(toRead);
			return null;
		} finally {
			active--;
			settle();
		}
	}

	let relistScheduled = false;
	function relistSoon() {
		if (relistScheduled || released) return;
		relistScheduled = true;
		queueMicrotask(() => {
			relistScheduled = false;
			void relist();
		});
	}

	// ---- writes ----------------------------------------------------------------

	function lane(path: string): Lane {
		let known = lanes.get(path);
		if (known === undefined) {
			known = {
				waiting: null,
				sending: false,
				epoch: 0,
				lastSent: Number.NEGATIVE_INFINITY,
				timer: undefined,
				reread: false,
			};
			lanes.set(path, known);
		}
		return known;
	}

	/** Queue `op` at `path`, merged into whatever waits there. */
	function enqueue(path: string, op: Op): Saved {
		if (!accepting) return Promise.resolve(EditError.Closed());
		const l = lane(path);
		const merged = l.waiting === null ? op : merge(l.waiting.op, op, path);
		if ('error' in merged) return Promise.resolve(Err(merged.error));
		return new Promise((resolve) => {
			if (l.waiting === null) l.waiting = { op: merged, resolves: [resolve] };
			else {
				l.waiting.op = merged;
				l.waiting.resolves.push(resolve);
			}
			schedule(path, l);
			commit();
		});
	}

	function schedule(path: string, l: Lane, now = false) {
		if (l.sending || l.waiting === null) return;
		clearTimeout(l.timer);
		l.timer = undefined;
		const wait = now ? 0 : l.lastSent + throttleMs - Date.now();
		if (wait <= 0) void send(path, l);
		else l.timer = setTimeout(() => void send(path, l), wait);
	}

	async function send(path: string, l: Lane) {
		clearTimeout(l.timer);
		l.timer = undefined;
		const waiting = l.waiting;
		if (waiting === null || l.sending) return;
		l.waiting = null;
		l.sending = true;
		l.lastSent = Date.now();
		const { op, resolves } = waiting;
		let attempted: Data | null | undefined;
		let outcome: Result<void, EditError>;
		try {
			const result = await land(path, op);
			attempted = result.attempted;
			outcome = result.outcome;
		} catch (cause) {
			outcome = SaveError.StorageFailed({ cause });
		}
		l.sending = false;
		if (outcome.error !== null) {
			const failure = { path, attempted, error: outcome.error };
			for (const listener of failureListeners) listener(failure);
		}
		for (const resolve of resolves) resolve(outcome);
		commit();
		if (l.reread) {
			l.reread = false;
			void readPaths([path]);
		}
		if (l.waiting !== null) schedule(path, l, !accepting);
		settle();
	}

	/** Put `op` at `path`, applying what landed to the mirror. */
	async function land(
		path: string,
		op: Op,
	): Promise<{
		attempted: Data | null | undefined;
		outcome: Result<void, EditError>;
	}> {
		const l = lane(path);
		if (op.kind === 'write') {
			const put = await host.put(path, encode(op.data), 'any');
			if (put.error !== null)
				return { attempted: op.data, outcome: Err(put.error) };
			if (put.data === 'stale')
				return {
					attempted: op.data,
					outcome: SaveError.StorageFailed({
						cause: 'storage answered stale to an unconditional put',
					}),
				};
			l.epoch++;
			const { landed } = put.data;
			set(
				path,
				landed === null || op.data === null
					? undefined
					: {
							value: {
								path,
								mime: mimeOf(path),
								data: op.data,
								readError: null,
							},
							version: landed.version,
							token: landed.token,
						},
			);
			return { attempted: op.data, outcome: Ok(undefined) };
		}
		let attempted: Data | null | undefined;
		for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
			const base = op.kind === 'create' ? undefined : mirror.get(path);
			if (op.kind === 'update' && base?.value.data === undefined)
				return {
					attempted,
					outcome: EditError.NothingToUpdate({ path }),
				};
			if (base?.value.data instanceof Uint8Array)
				return { attempted, outcome: SaveError.NotText() };
			const composed = applyPatch(base?.value.data ?? null, op.patch, op.keys);
			if (composed.error !== null)
				return {
					attempted,
					outcome: SaveError.Unparseable({ reason: composed.error.reason }),
				};
			// An update that changes no value lands without a write.
			if (composed.data === 'unchanged')
				return { attempted, outcome: Ok(undefined) };
			attempted = composed.data;
			const expected: Expected =
				base === undefined
					? 'absent'
					: base.version === null
						? 'any'
						: { version: base.version };
			const put = await host.put(path, encode(attempted), expected);
			if (put.error !== null) return { attempted, outcome: Err(put.error) };
			if (put.data !== 'stale') {
				l.epoch++;
				const { landed } = put.data;
				set(
					path,
					landed === null
						? undefined
						: {
								value: {
									path,
									mime: mimeOf(path),
									data: attempted,
									readError: null,
								},
								version: landed.version,
								token: landed.token,
							},
				);
				return { attempted, outcome: Ok(undefined) };
			}
			// Storage moved: read what is there now, then try again over it.
			const reread = await host.read([path]).catch((cause: unknown) => {
				const failed = ReadError.StorageFailed({ cause });
				return new Map([[path, failed]]);
			});
			const result = reread.get(path);
			if (result !== undefined) applyRead(path, result);
			commit();
			if (op.kind === 'create')
				return { attempted, outcome: EditError.Exists({ path }) };
			if (result === undefined || result.error !== null)
				return {
					attempted,
					outcome: SaveError.StorageFailed({ cause: result?.error }),
				};
		}
		return { attempted, outcome: EditError.KeptChanging({ path }) };
	}

	// ---- tables ----------------------------------------------------------------

	type TableView = {
		owns(path: string): boolean;
		refresh(): void;
		notify(): void;
	};

	function table<S extends Schema>(directory: string, schema: S): Table<S> {
		const prefix = `${directory}/`;
		const extension = '.md';
		const keys = declaredKeysOf(schema);
		const pathOf = (id: string) => `${prefix}${id}${extension}`;
		const idOf = (path: string) => {
			if (!path.startsWith(prefix) || !path.endsWith(extension))
				return undefined;
			const id = path.slice(prefix.length, path.length - extension.length);
			return id === '' || id.includes('/') ? undefined : id;
		};

		const parsed = new Map<
			string,
			{ readonly from: FileValue; readonly row: Row<S> }
		>();
		let byId = new Map<string, Row<S>>();
		let rowsSnapshot: readonly Row<S>[] = [];
		const rows = createStore(() => rowsSnapshot);

		function refresh() {
			const next = new Map<string, Row<S>>();
			for (const entry of mirror.values()) {
				const id = idOf(entry.value.path);
				if (id === undefined) continue;
				const known = parsed.get(id);
				const row =
					known?.from === entry.value
						? known.row
						: rowOf(id, entry.value, schema);
				parsed.set(id, { from: entry.value, row });
				next.set(id, row);
			}
			for (const id of parsed.keys()) if (!next.has(id)) parsed.delete(id);
			byId = next;
			rowsSnapshot = [...next.values()];
		}

		tableViews.push({
			owns: (path) => idOf(path) !== undefined,
			refresh,
			notify: rows.notify,
		});
		refresh();

		return {
			rows,
			row: (id) => byId.get(id),
			create(id, init) {
				if (id === '' || id.includes('/'))
					return Promise.resolve(SaveError.InvalidId({ id }));
				const path = pathOf(id);
				const l = lanes.get(path);
				if (mirror.has(path) || l?.waiting != null || l?.sending)
					return Promise.resolve(EditError.Exists({ path }));
				return enqueue(path, {
					kind: 'create',
					patch: {
						// SAFETY: a table's schema describes frontmatter, which is always a mapping.
						fields: init.fields as Record<string, unknown>,
						body: init.body ?? '',
					},
					keys,
				});
			},
			update(id, patch) {
				const path = pathOf(id);
				const l = lanes.get(path);
				if (!mirror.has(path) && l?.waiting == null && !l?.sending)
					return Promise.resolve(EditError.NothingToUpdate({ path }));
				return enqueue(path, {
					kind: 'update',
					// SAFETY: a patch's fields are part of the table's frontmatter mapping.
					patch: patch as RowPatch,
					keys,
				});
			},
			delete: (id) => enqueue(pathOf(id), { kind: 'write', data: null }),
		};
	}

	// ---- the folder ------------------------------------------------------------

	const stopHints = host.hints?.((paths) => {
		if (released) return;
		if (paths === null) return relistSoon();
		const toRead: string[] = [];
		for (const path of paths) {
			const l = lanes.get(path);
			if (l?.sending) l.reread = true;
			else if (kept(path)) toRead.push(path);
		}
		void readPaths(toRead);
		relistSoon();
	});

	function release() {
		released = true;
		stopHints?.();
		for (const l of lanes.values()) clearTimeout(l.timer);
		host.close?.();
	}

	let closing: Promise<void> | undefined;

	const folder: Folder<T> = {
		files,
		file: (path) => mirror.get(path)?.value,
		async read(path) {
			const results = await host.read([path]).catch((cause: unknown) => {
				const failed = ReadError.StorageFailed({ cause });
				return new Map([[path, failed]]);
			});
			const result = results.get(path);
			if (result === undefined)
				return ReadError.StorageFailed({ cause: `No read answered ${path}` });
			if (result.error !== null) return Err(result.error);
			return Ok(result.data?.bytes ?? null);
		},
		write: (path, data) => enqueue(path, { kind: 'write', data }),
		delete: (path) => enqueue(path, { kind: 'write', data: null }),
		// SAFETY: one table per key of `tables`, each over that key's schema.
		tables: Object.fromEntries(
			Object.entries(tables).map(([name, schema]) => [
				name,
				table(name, schema),
			]),
		) as Folder<T>['tables'],
		saving,
		onSaveFailed(listener) {
			failureListeners.add(listener);
			return () => failureListeners.delete(listener);
		},
		checkpoint() {
			for (const [path, l] of lanes) schedule(path, l, true);
			relistSoon();
		},
		close() {
			closing ??= (async () => {
				accepting = false;
				for (const [path, l] of lanes) schedule(path, l, true);
				await idle();
				release();
			})();
			return closing;
		},
	};

	const listed = await relist();
	if (listed !== null) {
		release();
		return OpenError.ListFailed({ cause: listed });
	}
	return Ok(folder);
}

// ---- pure helpers ------------------------------------------------------------

/**
 * Merge a new op into the one waiting at a path. A whole write replaces what
 * waits; an update merges into a waiting update or create, and applies to a
 * waiting whole write's text.
 */
function merge(waiting: Op, next: Op, path: string): Op | { error: EditError } {
	if (next.kind === 'create') return EditError.Exists({ path });
	if (next.kind === 'write') return next;
	if (waiting.kind === 'write') {
		if (waiting.data === null) return EditError.NothingToUpdate({ path });
		if (typeof waiting.data !== 'string') return SaveError.NotText();
		const changed = applyPatch(waiting.data, next.patch, next.keys);
		if (changed.error !== null)
			return SaveError.Unparseable({ reason: changed.error.reason });
		return changed.data === 'unchanged'
			? waiting
			: { kind: 'write', data: changed.data };
	}
	const fields =
		waiting.patch.fields === undefined && next.patch.fields === undefined
			? undefined
			: { ...waiting.patch.fields, ...next.patch.fields };
	const body = next.patch.body ?? waiting.patch.body;
	return {
		kind: waiting.kind,
		keys: waiting.keys,
		patch: {
			...(fields === undefined ? {} : { fields }),
			...(body === undefined ? {} : { body }),
		},
	};
}

function rowOf<S extends Schema>(
	id: string,
	file: FileValue,
	schema: S,
): Row<S> {
	const { path } = file;
	if (file.data === undefined) {
		const error =
			file.readError ?? ReadError.StorageFailed({ cause: 'never read' }).error;
		return {
			id,
			path,
			fields: undefined,
			body: undefined,
			issues: [{ kind: 'unreadable', message: error.message, path: [], error }],
		};
	}
	const value = readMarkdown(file.data, schema);
	if (value.issues === null)
		return { id, path, fields: value.fields, body: value.body, issues: null };
	const [first, ...rest] = value.issues;
	return {
		id,
		path,
		fields: value.fields,
		body: value.body,
		issues:
			first === undefined
				? [{ kind: 'frontmatter', message: 'The row did not read', path: [] }]
				: [first, ...rest],
	};
}

function mediaEntry(path: string, stat: Listed): Entry {
	return {
		value: { path, mime: mimeOf(path), data: undefined, readError: null },
		version: null,
		token: stat.token,
	};
}

/** Text when the bytes are UTF-8 (byte-exact, BOM kept), bytes otherwise. */
function decode(bytes: Uint8Array): Data {
	try {
		return decoder.decode(bytes);
	} catch {
		return bytes;
	}
}

function encode(data: Data | null): Uint8Array | null {
	if (data === null) return null;
	return typeof data === 'string' ? encoder.encode(data) : data;
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
	const dot = path.lastIndexOf('.');
	const extension = dot === -1 ? '' : path.slice(dot + 1).toLowerCase();
	return MIME.get(extension) ?? 'application/octet-stream';
}

/** Whether the mirror keeps a file's contents: everything but media. */
function kept(path: string): boolean {
	const mime = mimeOf(path);
	return !(
		(mime.startsWith('image/') && mime !== 'image/svg+xml') ||
		mime.startsWith('audio/') ||
		mime.startsWith('video/') ||
		mime === 'application/pdf' ||
		mime === 'application/zip'
	);
}
