/**
 * An opened folder: a mirror of what landed on disk, and the one way to
 * change it.
 *
 * Opening lists the folder and reads every text file (an allow-list of text
 * extensions, plus names without one), so every read after that is
 * synchronous and complete. Other files are listed but not kept; `read`
 * fetches their bytes when a view needs them.
 *
 * The mirror never runs ahead of the disk. A write goes down to storage, and
 * the mirror changes when the write's answer comes back or a read sees
 * another writer's change. A failed write therefore needs no rollback: the
 * mirror still shows the disk. The one thing allowed to run ahead of the
 * disk is what a person is typing, which an editor keeps in a draft.
 *
 * Every operation that changes the mirror (listing, reads, and each path's
 * save) runs in one serial queue, in the order it was asked for. So a read
 * asked for after a save lands sees it, and a listing taken before a create
 * cannot erase the created row.
 *
 * Writes wait per path. The first write after a quiet `throttleMs` is sent
 * at once; writes made while one is out, or within that window, wait and go
 * together. A save applies its waiting writes in order over the file as it
 * is then: a whole write replaces it, a delete removes it, a create refuses
 * with `Exists` when a file is there, and an update sets the fields and body
 * it names, as an SQL `UPDATE` does, written in the canonical form
 * (`patch.ts`). When storage moved under the save, the folder rereads the
 * path and applies the same writes again, up to three times.
 */
import type { TSchema as Schema, Static } from 'typebox';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { OpenFolderError } from '../errors.js';
import { invalidTable } from '../paths.js';
import { ReadError, SaveError } from '../shared/errors.js';
import {
	type Issue as MarkdownIssue,
	readMarkdown,
} from '../shared/markdown-codec.js';
import { type WriteError, WriteRefusal } from './errors.js';
import { applyPatch, declaredKeysOf, type RowPatch } from './patch.js';
import type {
	Expected,
	Fetched,
	FolderHost,
	Listed,
	PutLanding,
} from './storage.js';

/** A file's contents: text when the bytes are UTF-8, bytes otherwise. */
export type Data = string | Uint8Array;

/** One listed file, as it is on disk. */
export type FileValue = {
	readonly path: string;
	readonly mime: string;
	/**
	 * What is on disk: text, or bytes when a kept file is not UTF-8.
	 * `undefined` for a file the mirror does not keep (see `read`), and for a
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
/** Fields and the body to set on a row's file as it is when the save runs; a field set to `undefined` is removed. */
export type Patch<S extends Schema = Schema> = {
	readonly fields?: Partial<Static<S>>;
	readonly body?: string;
};
/** Answers once the write landed and the mirror shows it, or why it did not land. */
export type Saved = Promise<Result<void, WriteError>>;
/** One failed send for a path, with the last typed text in its batch. */
export type SaveFailure = {
	path: string;
	error: WriteError;
	text: string | undefined;
};

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
	files(): readonly FileValue[];
	file(path: string): FileValue | undefined;
	/** Whether a write is waiting or being saved. */
	saving(): boolean;
	/**
	 * Called once for each send that did not land, with the last typed text it
	 * carried. A create finding a file there (`Exists`) and an update finding
	 * none (`NothingToUpdate`) are answers for the caller, who decides what they
	 * mean, so they raise no notice; a draft shows its own.
	 */
	onFailed(listener: (failure: SaveFailure) => void): () => void;
	/** A file's bytes from storage, `null` when no file is there; for files the mirror does not keep. */
	read(path: string): Promise<Result<Uint8Array | null, ReadError>>;
	/** Replace the whole file. */
	write(path: string, data: Data): Saved;
	/** Set fields and the body on a Markdown file at any path; `schema` orders its declared keys first. */
	update(
		path: string,
		patch: { fields?: Record<string, unknown>; body?: string },
		options?: { schema?: Schema },
	): Saved;
	delete(path: string): Saved;
	readonly tables: { readonly [K in keyof T]: Table<T[K]> };
	/** Look at storage again, and send waiting writes now: on focus, visibility, wake, and before the page hides. */
	checkpoint(): void;
	/** Send this path's waiting writes now and answer after its last Saved answer. */
	settled(path: string): Promise<void>;
	/** Refuse new writes, send what waits, wait for the queue, then release storage. */
	close(): Promise<void>;
};

export type OpenOptions<T extends Tables> = {
	/** Each key is a top-level directory of `<id>.md` rows read through its schema. */
	readonly tables: T;
	/** The least time between two saves of one path; typing saves about this often. */
	readonly throttleMs?: number;
};
export type Opened<T extends Tables> = Promise<
	Result<Folder<T>, OpenFolderError>
>;

type Entry = {
	value: FileValue;
	version: string | null;
	token: string | undefined;
};
type Op =
	| { kind: 'write'; data: Data | null }
	| { kind: 'create' | 'update'; patch: RowPatch; keys: readonly string[] };
type Waiting = { op: Op; resolve: (result: Result<void, WriteError>) => void };
type Lane = {
	waiting: Waiting[];
	sending: boolean;
	force: boolean;
	timer: ReturnType<typeof setTimeout> | undefined;
};
type Projector = {
	set(path: string, value: FileValue | undefined): void;
	finish(): void;
};

const ATTEMPTS = 3;
/** Refusals that answer the caller's question rather than report a failure. */
const CALLERS_REFUSALS: ReadonlySet<string> = new Set([
	'Exists',
	'NothingToUpdate',
]);
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
	{ tables, throttleMs = 1000 }: OpenOptions<T>,
): Opened<T> {
	// The browser repository also refuses malformed Unicode table names.
	const invalid =
		invalidTable(tables) ??
		Object.keys(tables).find((name) => !name.isWellFormed());
	if (invalid !== undefined) {
		host.close?.();
		return OpenFolderError.InvalidTable({ table: invalid });
	}
	const mirror = new Map<string, Entry>();
	const lanes = new Map<string, Lane>();
	const lastSent = new Map<string, number>();
	const settledWaiters = new Map<string, Set<() => void>>();
	const listeners = new Set<() => void>();
	const failedListeners = new Set<(failure: SaveFailure) => void>();
	const dirtyProjectors = new Set<Projector>();
	const projectorsByDirectory = new Map<string, Projector>();
	let filesSnapshot: readonly FileValue[] = [];
	let filesDirty = false;
	let changed = false;
	let savingSnapshot = false;
	let accepting = true;
	let released = false;
	let tail = Promise.resolve();

	/** Run `work` after everything queued before it; the queue goes on if it throws. */
	function queue<TValue>(work: () => Promise<TValue>): Promise<TValue> {
		const next = tail.then(work);
		tail = next.then(
			() => {},
			() => {},
		);
		return next;
	}

	/** Publish what changed since the last notice, once: snapshots first, then listeners. */
	function notice() {
		const saving = lanes.size > 0;
		if (saving !== savingSnapshot) {
			savingSnapshot = saving;
			changed = true;
		}
		if (!changed) return;
		changed = false;
		if (filesDirty) {
			filesDirty = false;
			filesSnapshot = [...mirror.values()]
				.map((entry) => entry.value)
				.sort((a, b) => compare(a.path, b.path));
		}
		for (const projector of dirtyProjectors) projector.finish();
		dirtyProjectors.clear();
		for (const listener of [...listeners]) listener();
	}

	function set(path: string, entry: Entry | undefined) {
		const before = mirror.get(path);
		if (entry === undefined) {
			if (before === undefined) return;
			mirror.delete(path);
		} else {
			if (before?.value === entry.value) {
				mirror.set(path, entry);
				return;
			}
			mirror.set(path, entry);
		}
		changed = true;
		filesDirty = true;
		const slash = path.indexOf('/');
		if (slash !== -1) {
			const projector = projectorsByDirectory.get(path.slice(0, slash));
			if (projector !== undefined) {
				projector.set(path, entry?.value);
				dirtyProjectors.add(projector);
			}
		}
	}

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
		if (!kept(path)) {
			if (before?.token === fetched.token && before.value.readError === null)
				return;
			return set(path, mediaEntry(path, fetched));
		}
		if (
			before?.version === fetched.version &&
			before.value.readError === null
		) {
			mirror.set(path, { ...before, token: fetched.token });
			return;
		}
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

	async function readPaths(paths: readonly string[]) {
		if (paths.length === 0 || released) return;
		const results = await host
			.read(paths)
			.catch(
				(cause: unknown) =>
					new Map(
						paths.map((path) => [path, ReadError.StorageFailed({ cause })]),
					),
			);
		for (const path of paths) {
			const result = results.get(path);
			if (result !== undefined) applyRead(path, result);
		}
		notice();
	}

	/** A listing and its reads become visible together, after the last await. */
	async function relist(): Promise<ReadError | null> {
		if (released) return null;
		const { data: listed, error } = await host
			.list()
			.catch((cause: unknown) => ReadError.StorageFailed({ cause }));
		if (error !== null) return error;
		const toRead: string[] = [];
		const media = new Map<string, Entry>();
		for (const [path, stat] of listed) {
			const entry = mirror.get(path);
			if (!kept(path)) {
				if (
					entry === undefined ||
					entry.token !== stat.token ||
					entry.value.readError !== null
				)
					media.set(path, mediaEntry(path, stat));
				continue;
			}
			if (
				entry === undefined ||
				entry.token !== stat.token ||
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
		for (const path of mirror.keys())
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
		notice();
		return null;
	}

	let relistQueued = false;
	function queueRelist() {
		if (relistQueued || released) return;
		relistQueued = true;
		void queue(async () => {
			relistQueued = false;
			await relist();
		});
	}

	const queuedHints = new Set<string>();
	function hint(path: string) {
		if (!kept(path) || queuedHints.has(path)) return;
		queuedHints.add(path);
		void queue(async () => {
			queuedHints.delete(path);
			await readPaths([path]);
		});
	}

	function lane(path: string): Lane {
		let current = lanes.get(path);
		if (current === undefined) {
			const now = Date.now();
			for (const [key, sent] of lastSent)
				if (now - sent >= throttleMs) lastSent.delete(key);
			current = {
				waiting: [],
				sending: false,
				force: settledWaiters.has(path),
				timer: undefined,
			};
			lanes.set(path, current);
		}
		return current;
	}

	function enqueue(path: string, op: Op): Saved {
		if (!accepting) return Promise.resolve(WriteRefusal.Closed());
		const current = lane(path);
		const saved: Saved = new Promise((resolve) =>
			current.waiting.push({ op, resolve }),
		);
		schedule(path, current, current.force);
		notice();
		return saved;
	}

	function schedule(path: string, current: Lane, now = false) {
		if (current.sending || current.waiting.length === 0) return;
		if (now) clearTimeout(current.timer);
		else if (current.timer !== undefined) return;
		current.timer = undefined;
		const delay = now
			? 0
			: (lastSent.get(path) ?? Number.NEGATIVE_INFINITY) +
				throttleMs -
				Date.now();
		if (delay > 0)
			current.timer = setTimeout(() => schedule(path, current, true), delay);
		else {
			current.sending = true;
			void queue(() => send(path, current));
		}
	}

	async function send(path: string, current: Lane) {
		const batch = current.waiting.splice(0);
		lastSent.set(path, Date.now());
		const answers = new Map<Waiting, Result<void, WriteError>>();
		try {
			await land(path, batch, answers);
		} catch (cause) {
			for (const item of batch)
				answers.set(item, SaveError.StorageFailed({ cause }));
		}
		current.sending = false;
		if (current.waiting.length > 0)
			schedule(path, current, current.force || !accepting);
		else lanes.delete(path);
		for (const item of batch) item.resolve(answers.get(item) ?? Ok(undefined));
		notice();
		const failure = [...batch]
			.reverse()
			.map((item) => answers.get(item)?.error)
			.find(
				(error): error is WriteError =>
					error !== null &&
					error !== undefined &&
					!CALLERS_REFUSALS.has(error.name),
			);
		queueMicrotask(() => {
			if (failure !== undefined) {
				const text = [...batch]
					.reverse()
					.map((item) => typedTextOf(item.op))
					.find((value) => value !== undefined);
				for (const listener of [...failedListeners])
					listener({ path, error: failure, text });
			}
			if (lanes.has(path)) return;
			const waiters = settledWaiters.get(path);
			settledWaiters.delete(path);
			for (const resolve of waiters ?? []) resolve();
		});
	}

	/** Apply `batch` in order over the file as it is, put the result, and answer each write. */
	async function land(
		path: string,
		batch: Waiting[],
		answers: Map<Waiting, Result<void, WriteError>>,
	) {
		const refused = new Map<Waiting, Result<void, WriteError>>();
		for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
			refused.clear();
			const base = mirror.get(path);
			const original = base?.value.data ?? null;
			let text: Data | null = original;
			let writesFirst = false;
			let consultedBase = false;
			for (const item of batch) {
				const op = item.op;
				if (op.kind === 'write') {
					text = op.data;
					writesFirst = true;
					continue;
				}
				if (!writesFirst) consultedBase = true;
				if (op.kind === 'create' && text !== null) {
					refused.set(item, WriteRefusal.Exists({ path }));
					continue;
				}
				if (op.kind === 'update' && text === null) {
					refused.set(item, WriteRefusal.NothingToUpdate({ path }));
					continue;
				}
				if (text instanceof Uint8Array) {
					refused.set(item, SaveError.NotText());
					continue;
				}
				const patched = applyPatch(text, op.patch, op.keys);
				if (patched.error !== null) {
					refused.set(
						item,
						SaveError.Unparseable({ reason: patched.error.reason }),
					);
					continue;
				}
				if (patched.data !== 'unchanged') text = patched.data;
			}
			if (
				(base === undefined && text === null) ||
				(base?.value.data !== undefined && sameData(text, original))
			) {
				for (const item of batch)
					answers.set(item, refused.get(item) ?? Ok(undefined));
				return;
			}
			const expected: Expected = consultedBase
				? base === undefined || base.version === null
					? 'absent'
					: { version: base.version }
				: 'any';
			const put = await host.put(path, encode(text), expected);
			if (put.error !== null) {
				for (const item of batch)
					answers.set(item, refused.get(item) ?? Err(put.error));
				return;
			}
			if (expected !== 'any' && put.data === 'stale') {
				const reread = await host
					.read([path])
					.catch(
						(cause: unknown) =>
							new Map([[path, ReadError.StorageFailed({ cause })]]),
					);
				const result = reread.get(path);
				if (result === undefined || result.error !== null) {
					const error = SaveError.StorageFailed({ cause: result?.error });
					for (const item of batch)
						answers.set(item, refused.get(item) ?? error);
					return;
				}
				applyRead(path, result);
				notice();
				continue;
			}
			// SAFETY: an unconditional host put never answers stale.
			const landed = (put.data as PutLanding).landed;
			set(
				path,
				landed === null
					? undefined
					: {
							value: {
								path,
								mime: mimeOf(path),
								data:
									kept(path) && text !== null
										? typeof text === 'string'
											? text
											: decode(text)
										: undefined,
								readError: null,
							},
							version: landed.version,
							token: landed.token,
						},
			);
			for (const item of batch)
				answers.set(item, refused.get(item) ?? Ok(undefined));
			return;
		}
		for (const item of batch)
			answers.set(
				item,
				refused.get(item) ?? WriteRefusal.KeptChanging({ path }),
			);
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
		const byId = new Map<string, { from: FileValue; row: Row<S> }>();
		let rowsSnapshot: readonly Row<S>[] = [];
		let dirty = false;
		const projector: Projector = {
			set(path, value) {
				const id = idOf(path);
				if (id === undefined) return;
				if (value === undefined) {
					if (byId.delete(id)) dirty = true;
					return;
				}
				if (byId.get(id)?.from === value) return;
				byId.set(id, { from: value, row: rowOf(id, value, schema) });
				dirty = true;
			},
			finish() {
				if (!dirty) return;
				dirty = false;
				rowsSnapshot = [...byId.entries()]
					.sort(([a], [b]) => compare(a, b))
					.map(([, value]) => value.row);
			},
		};
		projectorsByDirectory.set(directory, projector);
		return {
			rows: () => rowsSnapshot,
			row: (id) => byId.get(id)?.row,
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
		if (released) return;
		if (paths !== null) for (const path of paths) hint(path);
		queueRelist();
	});
	const folder: Folder<T> = {
		subscribe(onChange) {
			listeners.add(onChange);
			return () => listeners.delete(onChange);
		},
		files: () => filesSnapshot,
		file: (path) => mirror.get(path)?.value,
		saving: () => savingSnapshot,
		onFailed(listener) {
			failedListeners.add(listener);
			return () => failedListeners.delete(listener);
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
		write: (path, data) => enqueue(path, { kind: 'write', data }),
		update: (path, patch, options) =>
			enqueue(path, {
				kind: 'update',
				patch,
				keys: declaredKeysOf(options?.schema),
			}),
		delete: (path) => enqueue(path, { kind: 'write', data: null }),
		// SAFETY: one table was built for each key in T.
		tables: Object.fromEntries(tableEntries) as Folder<T>['tables'],
		checkpoint() {
			for (const [path, current] of lanes) {
				if (current.sending && current.waiting.length > 0) {
					void queue(async () => {
						if (lanes.get(path) === current) schedule(path, current, true);
					});
				} else schedule(path, current, true);
			}
			queueRelist();
		},
		settled(path) {
			const current = lanes.get(path);
			if (current === undefined) return Promise.resolve();
			current.force = true;
			schedule(path, current, true);
			return new Promise((resolve) => {
				let waiters = settledWaiters.get(path);
				if (waiters === undefined) {
					waiters = new Set();
					settledWaiters.set(path, waiters);
				}
				waiters.add(resolve);
			});
		},
		close() {
			closing ??= (async () => {
				accepting = false;
				for (const [path, current] of lanes) schedule(path, current, true);
				while (lanes.size > 0) await tail;
				await tail;
				released = true;
				stopHints?.();
				host.close?.();
			})();
			return closing;
		},
	};
	let closing: Promise<void> | undefined;
	const first = await queue(relist);
	if (first !== null) {
		released = true;
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
function sameData(a: Data | null, b: Data | null) {
	if (a === b) return true;
	if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array)) return false;
	return a.length === b.length && a.every((value, index) => value === b[index]);
}
/**
 * The text a person typed into a write, to offer for copying when it does
 * not land: a non-empty body, or the one string field a patch sets. Anything
 * else (a status change, several fields, an empty body) answers `undefined`,
 * since there is no typed text to give back.
 */
function typedText(patch: {
	readonly fields?: object;
	readonly body?: string;
}): string | undefined {
	if (patch.body !== undefined && patch.body !== '') return patch.body;
	const strings = Object.values(patch.fields ?? {}).filter(
		(value): value is string => typeof value === 'string' && value !== '',
	);
	return strings.length === 1 ? strings[0] : undefined;
}

function typedTextOf(op: Op): string | undefined {
	return op.kind === 'write'
		? typeof op.data === 'string'
			? op.data
			: undefined
		: typedText(op.patch);
}

/** What a row's text reads as through its schema: the fields, body, and any issues. */
export type RowReading<S extends Schema = Schema> =
	| { readonly fields: Static<S>; readonly body: string; readonly issues: null }
	| {
			readonly fields: Record<string, unknown> | undefined;
			readonly body: string | undefined;
			readonly issues: readonly [RowIssue, ...RowIssue[]];
	  };

/**
 * Read row text through `schema`, as the mirror reads a saved row. For a
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
	file: FileValue,
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
		version: null,
		token: stat.token,
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
/** Whether the mirror keeps a file's contents: text extensions, and names with no extension or only a leading dot. */
function kept(path: string): boolean {
	const segment = path.slice(path.lastIndexOf('/') + 1);
	const dot = segment.lastIndexOf('.');
	return dot <= 0 || keptExtensions.has(segment.slice(dot + 1).toLowerCase());
}
