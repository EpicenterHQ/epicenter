/**
 * The app API, the same for every host: reads and live queries are
 * asynchronous; a person's write applies on the device and resolves once it
 * is saved there, never waiting for the server; `send` waits for the
 * server's verdict and changes nothing here before it; what happens later to
 * a saved write that the person should know is a notice; and an open note
 * reads synchronously.
 *
 * `createRepository` builds it over an `EnginePort`: the engine itself in
 * the caller's thread (`openRepository`, used by Bun and tests), or the
 * owning browser tab's connection to its worker (`openBrowserRepository`).
 */
import type { TSchema } from 'typebox';
import { Check, Errors } from 'typebox/value';
import { defineErrors } from 'wellcrafted/error';
import { createLogger, type Logger } from 'wellcrafted/logger';
import type { Result } from 'wellcrafted/result';
import type {
	App,
	BatchHandles,
	BlobEntry,
	Definitions,
	Handles,
	LaterVerdict,
	Lens,
	Live,
	NoteName,
	Notice,
	OpenFile,
	Saved,
	SendError,
	SendHandles,
	SendOptions,
	Sync,
	TextFile,
	TextStatus,
	Verdict,
} from './define.js';
import { WriteError } from './define.js';
import {
	type EngineAnswers,
	type EngineOptions,
	type EngineRequest,
	type FileRead,
	openEngine,
	type WriteOp,
} from './engine/engine.js';
import { gitBlobHash } from './core/hash.js';
import { parseMarkdown, parsePointer, parses, splitMarkdown, writeMarkdown } from './core/markdown.js';
import type { SqlValue } from './sql.js';
import { buildPath, matchTemplate } from './templates.js';

/** What the app API needs from wherever the engine runs. */
export type EnginePort = {
	read<TRequest extends EngineRequest>(request: TRequest): Promise<EngineAnswers[TRequest['kind']]>;
	/** Apply writes on the device and send them; resolves once they are saved. */
	submit(ops: WriteOp[]): Saved;
	/** Send ops as one batch that refuses on overlap, and answer the verdict. */
	send(ops: WriteOp[]): Promise<Result<Verdict, WriteError | SendError>>;
	/** Remove a notice the person has seen. */
	dismiss(id: number): Promise<void>;
	/** Called with the paths whose shown text changed, after every change; null when any may have. */
	onChange(listener: (paths: string[] | null) => void): () => void;
	close(): void;
};

const ClientDiagnostic = defineErrors({
	LiveQueryFailed: ({ cause }: { cause: unknown }) => ({
		message: 'A live query failed to re-run; it runs again on the next change',
		cause,
	}),
});

type Params = Record<string, unknown>;
type NoteChange = { fields?: Record<string, unknown>; body?: string };

/** How `fields` fails `schema`, one line per issue; none when they match. */
function schemaIssues(schema: TSchema, fields: Record<string, unknown>): string[] {
	if (Check(schema, fields)) return [];
	return Errors(schema, fields).map((error) => `${error.instancePath || '/'} ${error.message}`);
}

/** A note read from a file row. Fields that fail the schema are returned raw, with issues. */
function noteOf(lens: Extract<Lens, { kind: 'note' }>, file: FileRead) {
	const params = matchTemplate(lens.template, file.path) ?? {};
	const base = { path: file.path, params, text: file.text, body: file.body, version: file.version, sync: file.sync };
	if (file.fields === null) return { ...base, valid: false, fields: {}, issues: ['The frontmatter does not parse'] };
	const fields = JSON.parse(file.fields) as Record<string, unknown>;
	const issues = schemaIssues(lens.schema, fields);
	return issues.length === 0 ? { ...base, valid: true, fields } : { ...base, valid: false, fields, issues };
}

/**
 * The same row, computed from text this client holds: what an open file
 * shows before the engine answers. Its sync state is the engine's guess
 * made from what it showed before, `shown`: held while it breaks text that
 * parsed, or stays broken while held; otherwise sending. The engine's answer
 * follows.
 */
function fileOf(path: string, text: string, shown: FileRead | null): FileRead {
	const parsed = parseMarkdown(text);
	const holds = parsed.error !== null && path.endsWith('.md') && (shown === null || shown.sync.state === 'held' || parses(shown.text));
	const sync: Sync = holds ? { state: 'held', reason: 'unparseable' } : { state: 'sending' };
	return {
		path,
		text,
		fields: parsed.error === null ? JSON.stringify(parsed.data.fields) : null,
		body: text.slice(splitMarkdown(text).bodyStart),
		version: gitBlobHash(text),
		sync,
	};
}

/** A file as `repo.files` returns it. */
const textFileOf = ({ path, text, version, sync }: FileRead): TextFile => ({ path, text, version, sync });

export function createRepository<const TDefs extends Definitions>(
	app: App<TDefs>,
	port: EnginePort,
	{ log = createLogger('repository') }: { log?: Logger } = {},
) {
	let closed = false;
	/** Live re-runs in flight, so `flush` can wait for them. */
	const running = new Set<Promise<void>>();
	const track = (work: Promise<void>) => {
		running.add(work);
		void work.finally(() => running.delete(work));
	};

	/**
	 * Re-run `run` after every change and call back when its result differs.
	 * One run is in flight at a time; a change during it runs it once more.
	 */
	function liveOf<T>(run: () => Promise<T>): Live<T> {
		return {
			subscribe(onChange) {
				let last: string | undefined;
				let busy = false;
				let again = false;
				let stopped = false;
				async function rerun() {
					if (busy) {
						again = true;
						return;
					}
					busy = true;
					try {
						do {
							again = false;
							const value = await run();
							if (stopped) return;
							const json = JSON.stringify(value);
							if (json === last) continue;
							last = json;
							onChange(value);
						} while (again && !stopped);
					} catch (cause) {
						log.warn(ClientDiagnostic.LiveQueryFailed({ cause }));
					} finally {
						busy = false;
					}
				}
				const stop = port.onChange(() => track(rerun()));
				track(rerun());
				return () => {
					stopped = true;
					stop();
				};
			},
		};
	}

	const submit = (ops: WriteOp[]): Saved => (closed ? Promise.resolve(WriteError.Closed()) : port.submit(ops));
	const save = (op: WriteOp) => submit([op]);

	/** A handle call's parameters and the rest of its arguments. */
	const split = (lens: Lens, args: unknown[]): [Params, unknown[]] =>
		lens.template.params.length === 0 ? [{}, args] : [(args[0] ?? {}) as Params, args.slice(1)];

	/** What a `send` change starts from, from its options argument; a direct call or a batch passes none. */
	const baseOf = (options: unknown) => {
		const from = (options as Partial<SendOptions> | undefined)?.from;
		// A Note carries more than the send needs; only what crosses to the engine goes.
		return from === undefined || from === 'latest' ? from : { path: from.path, text: from.text, version: from.version };
	};

	/** The ops a note handle builds: the same for a direct call, inside a batch, and inside a send. */
	function noteOps(lens: Extract<Lens, { kind: 'note' }>) {
		const name = lens.name;
		return {
			create: (...args: unknown[]): WriteOp => {
				const [params, [input]] = split(lens, args);
				return { kind: 'create', name, params, input: (input ?? {}) as NoteChange };
			},
			write: (...args: unknown[]): WriteOp => {
				const [params, [input, options]] = split(lens, args);
				return { kind: 'write', name, params, input: (input ?? {}) as NoteChange, base: baseOf(options) };
			},
			set: (...args: unknown[]): WriteOp => {
				const [params, [key, value, options]] = split(lens, args);
				return { kind: 'set', name, params, key: String(key), value, base: baseOf(options) };
			},
			append: (...args: unknown[]): WriteOp => {
				const [params, [text, options]] = split(lens, args);
				return { kind: 'append', name, params, text: String(text), base: baseOf(options) };
			},
			move: (...[from, to]: unknown[]): WriteOp => ({ kind: 'move', name, from: from as Params, to: to as Params }),
			delete: (...args: unknown[]): WriteOp => {
				const [params, [options]] = split(lens, args);
				return { kind: 'delete', name, params, base: baseOf(options) };
			},
		};
	}

	function blobOps(lens: Extract<Lens, { kind: 'blob' }>) {
		return {
			put: (...args: unknown[]): WriteOp => {
				const [params, [bytes, options]] = split(lens, args);
				const { type = '' } = (options ?? {}) as { type?: string };
				return { kind: 'put', name: lens.name, params, bytes: bytes as Uint8Array, type, base: baseOf(options) };
			},
			delete: (...args: unknown[]): WriteOp => {
				const [params, [options]] = split(lens, args);
				return { kind: 'delete', name: lens.name, params, base: baseOf(options) };
			},
		};
	}

	/** Write-only handles whose calls collect ops, for `batch` and `send`. */
	function collect(build: (handles: never) => void): WriteOp[] {
		const ops: WriteOp[] = [];
		const handles: Record<string, Record<string, (...args: never[]) => void>> = {};
		for (const lens of app.lenses) {
			const made: Record<string, (...args: unknown[]) => WriteOp> = lens.kind === 'note' ? noteOps(lens) : blobOps(lens);
			handles[lens.name] = Object.fromEntries(
				Object.entries(made).map(([verb, make]) => [verb, (...args: unknown[]) => void ops.push(make(...args))]),
			);
		}
		build(handles as never);
		return ops;
	}

	/**
	 * Hold one path open. It shows writes made through it at once, keeps
	 * showing them while they are applied, and otherwise reads again whenever
	 * the engine reports its path changed. `onShow` hears every text it shows.
	 */
	async function hold(path: string | null, readFile: () => Promise<FileRead | null>, onShow: (file: FileRead | null) => void) {
		let shown: FileRead | null = null;
		/** Writes through this hold not yet applied by the engine. */
		let applying = 0;
		/** Bumped by every write, so a read that a write overtook is dropped. */
		let generation = 0;
		const show = (next: FileRead | null) => {
			if ((next?.text ?? null) === (shown?.text ?? null) && next?.sync.state === shown?.sync.state) return;
			shown = next;
			onShow(next);
		};
		const refresh = async () => {
			const at = generation;
			const next = await readFile();
			if (at === generation && applying === 0) show(next);
		};
		// Listening before the first read, so a change while it runs reads again.
		const stop = port.onChange((paths) => {
			if (path !== null && (paths === null || paths.includes(path)) && applying === 0) track(refresh());
		});
		await refresh();
		return {
			/** The file as this hold shows it now. */
			shown: () => shown,
			/** Show the write's text now, then the engine's once it has saved every write made here. */
			through(op: WriteOp, text: string | null): Saved {
				if (path === null) return Promise.resolve(WriteError.InvalidPath({ path: '', reason: 'the parameters build no path' }));
				generation++;
				applying++;
				show(text === null ? null : fileOf(path, text, shown));
				const saved = submit([op]);
				track(
					saved.then(() => {
						applying--;
						if (applying === 0) return refresh();
					}),
				);
				return saved;
			},
			stop,
		};
	}

	/** Hold one note open; see `hold`. */
	async function open(lens: Extract<Lens, { kind: 'note' }>, params: Params) {
		const built = buildPath(lens.template, params);
		const path = built.error === null ? built.data : null;
		const ops = noteOps(lens);
		let note: ReturnType<typeof noteOf> | null = null;
		const listeners = new Set<(note: unknown) => void>();
		const held = await hold(
			path,
			() => (path === null ? Promise.resolve(null) : port.read({ kind: 'get', name: lens.name, params })),
			(file) => {
				note = file === null ? null : noteOf(lens, file);
				for (const listener of listeners) listener(note);
			},
		);
		const through = (op: WriteOp, text: string | null): Saved =>
			path === null
				? Promise.resolve(WriteError.InvalidParams({ handle: lens.name, reason: 'the parameters build no path' }))
				: held.through(op, text);
		/**
		 * The text a write leaves, as the engine computes it; an unparseable
		 * note is the engine's to refuse, and an absent one, which only
		 * `create` makes, shows nothing.
		 */
		const written = (change: Parameters<typeof writeMarkdown>[1]) => {
			const shown = held.shown()?.text ?? null;
			if (shown === null) return null;
			const text = writeMarkdown(shown, change);
			return text.error === null ? text.data : shown;
		};
		const args = (...rest: unknown[]) => (lens.template.params.length === 0 ? rest : [params, ...rest]);

		return {
			params,
			read: () => note,
			subscribe(onChange: (note: unknown) => void) {
				listeners.add(onChange);
				return () => {
					listeners.delete(onChange);
				};
			},
			write: (input: NoteChange) => through(ops.write(...args(input)), written(input)),
			edit: (body: string) =>
				through({ kind: 'edit', name: lens.name, params, from: held.shown()?.body ?? '', body }, written({ body })),
			set: (key: string, value: unknown) => through(ops.set(...args(key, value)), written({ fields: { [key]: value } })),
			append: (text: string) => {
				const shown = held.shown();
				return through(ops.append(...args(text)), shown === null ? null : shown.text + text);
			},
			delete: () => through(ops.delete(...args()), null),
			close() {
				held.stop();
				listeners.clear();
			},
		};
	}

	/** Hold any synced Markdown file open by its path; see `hold`. */
	async function openFile(path: string): Promise<OpenFile> {
		const listeners = new Set<(file: TextFile | null) => void>();
		const held = await hold(
			path,
			() => port.read({ kind: 'file', path }),
			(file) => {
				for (const listener of listeners) listener(file === null ? null : textFileOf(file));
			},
		);
		return {
			path,
			read: () => {
				const file = held.shown();
				return file === null ? null : textFileOf(file);
			},
			subscribe(onChange) {
				listeners.add(onChange);
				return () => {
					listeners.delete(onChange);
				};
			},
			writeText: (text) => held.through({ kind: 'text', path, text, from: held.shown()?.text ?? null }, text),
			close() {
				held.stop();
				listeners.clear();
			},
		};
	}

	/** Whether `text` parses, and, given a note name, whether its fields match that name's schema. */
	function status(text: string, name?: string): TextStatus {
		const parsed = parseMarkdown(text);
		if (parsed.error !== null) return { parses: false, line: parsed.error.line, message: parsed.error.reason };
		const lens = name === undefined ? undefined : app.lenses.find((candidate) => candidate.name === name);
		if (lens?.kind !== 'note') return { parses: true, matches: null };
		const issues = schemaIssues(lens.schema, parsed.data.fields);
		return issues.length === 0 ? { parses: true, matches: true } : { parses: true, matches: false, issues };
	}

	const listFiles = async ({ sync }: { sync?: Sync['state'] } = {}) => (await port.read({ kind: 'files', sync })).map(textFileOf);

	const listNotices = () =>
		port.read({
			kind: 'query',
			sql: 'SELECT id, at, kind, path, reason, kept FROM "epicenter/notices" ORDER BY id DESC',
			params: [],
		}) as Promise<Notice[]>;

	const handles: Record<string, unknown> = {};
	for (const lens of app.lenses) {
		const name = lens.name;
		if (lens.kind === 'note') {
			const ops = noteOps(lens);
			const list = async (filter: Params = {}) =>
				(await port.read({ kind: 'list', name, filter })).map((file) => noteOf(lens, file));
			handles[name] = {
				get: async (...args: unknown[]) => {
					const file = await port.read({ kind: 'get', name, params: split(lens, args)[0] });
					return file === null ? null : noteOf(lens, file);
				},
				list,
				live: (filter?: Params) => liveOf(() => list(filter)),
				open: (...args: unknown[]) => open(lens, split(lens, args)[0]),
				create: (...args: unknown[]) => save(ops.create(...args)),
				write: (...args: unknown[]) => save(ops.write(...args)),
				set: (...args: unknown[]) => save(ops.set(...args)),
				append: (...args: unknown[]) => save(ops.append(...args)),
				move: (from: Params, to: Params) => save(ops.move(from, to)),
				delete: (...args: unknown[]) => save(ops.delete(...args)),
			};
			continue;
		}
		const ops = blobOps(lens);
		const list = async (filter: Params = {}) =>
			(await port.read({ kind: 'list', name, filter })).flatMap((file): BlobEntry<string>[] => {
				const pointer = parsePointer(file.text);
				return pointer === null ? [] : [{ path: file.path, params: matchTemplate(lens.template, file.path) ?? {}, ...pointer }];
			});
		handles[name] = {
			put: (...args: unknown[]) => save(ops.put(...args)),
			get: (...args: unknown[]) => port.read({ kind: 'blob', name, params: split(lens, args)[0], as: 'bytes' }),
			url: (...args: unknown[]) => port.read({ kind: 'blob', name, params: split(lens, args)[0], as: 'url' }),
			list,
			live: (filter?: Params) => liveOf(() => list(filter)),
			delete: (...args: unknown[]) => save(ops.delete(...args)),
		};
	}

	return {
		...(handles as Handles<TDefs>),
		/**
		 * Build one batch from write-only handles: one server batch, which lands
		 * all or nothing. A change after a rename in it follows the rename,
		 * whether it names the note's old path or its new one.
		 */
		batch(build: (handles: BatchHandles<TDefs>) => void): Saved {
			return submit(collect(build));
		},
		/**
		 * Send one batch and wait for the server's verdict, for a caller that
		 * can read again and retry, such as an agent. Each change to an
		 * existing path names what it starts from: `{ from: note }`, the note
		 * as read, or `{ from: 'latest' }`. It is refused if it overlaps a
		 * change the server holds that its start lacks, including a change of
		 * this device's that did not land as read. Offline it fails at once
		 * with `Offline` and nothing is queued. It waits for earlier writes to
		 * its paths to be answered, changes nothing on this device before the
		 * verdict, and shows an applied one at once.
		 */
		send(build: (handles: SendHandles<TDefs>) => void): Promise<Result<Verdict, WriteError | SendError>> {
			if (closed) return Promise.resolve(WriteError.Closed());
			return port.send(collect(build));
		},
		/**
		 * The later verdict of a send that failed with `Unknown`, by its id:
		 * the outcome this device stored once the server answered the send
		 * again, `{ kind: 'unanswered' }` until then, or null for an id this
		 * device keeps no such send under. A stored outcome survives restarts
		 * until it is read: reading a final verdict (applied or refused)
		 * removes it, so a second read answers null.
		 */
		verdict: (id: number): Promise<LaterVerdict | null> => port.read({ kind: 'verdict', id }),
		/**
		 * Any synced Markdown file by its path, as text: one a template names
		 * or not, and one whose frontmatter parses or not. This is how a
		 * person repairs a file.
		 */
		files: {
			/** The file as this device shows it: its whole text, its version, and where it stands with the server; null when there is none. */
			readText: async (path: string): Promise<TextFile | null> => {
				const file = await port.read({ kind: 'file', path });
				return file === null ? null : textFileOf(file);
			},
			/** Every file this device shows, or only those in one sync state, such as `{ sync: 'held' }`. */
			list: listFiles,
			/** `list`, re-run after every change, its sync states included. */
			live: (filter: { sync?: Sync['state'] } = {}): Live<TextFile[]> => liveOf(() => listFiles(filter)),
			/**
			 * Replace the file's whole text, frontmatter included: a person's
			 * write, which resolves once saved here and merges at the server by
			 * frontmatter key and body when both sides parse, and by line when
			 * either does not. A text that would turn frontmatter that parses into
			 * frontmatter that does not is saved here and held, not sent, until
			 * it parses (see `Sync`), so no synced note ever stops parsing, and a
			 * broken file saves every step of its repair.
			 */
			writeText: (path: string, text: string): Saved => save({ kind: 'text', path, text }),
			/** Hold the file open: reads are synchronous and follow every change, as a note's `open`. */
			open: openFile,
			/** Whether a text parses, and, given a note name, whether it matches that name's schema. */
			status: (text: string, name?: NoteName<TDefs>): TextStatus => status(text, name),
		},
		/**
		 * What happened to this device's saved changes that the person should
		 * know, newest first: kept on this device, never synced, each until
		 * the person dismisses it, since one can be the only copy of a value.
		 */
		notices: {
			list: listNotices,
			live: (): Live<Notice[]> => liveOf(listNotices),
			dismiss: (id: number) => (closed ? Promise.resolve() : port.dismiss(id)),
		},
		/**
		 * Run one statement over the app's views and the engine's tables. It
		 * reads only: more than one statement, or one that could change the
		 * database or the connection (a write, a transaction, ATTACH, a
		 * PRAGMA), is refused, so every change goes through the engine.
		 */
		query: <TRow = Record<string, SqlValue>>(sql: string, params: SqlValue[] = []) =>
			port.read({ kind: 'query', sql, params }) as Promise<TRow[]>,
		/** `query`, re-run after every change. */
		live: <TRow = Record<string, SqlValue>>(sql: string, params: SqlValue[] = []): Live<TRow[]> =>
			liveOf(() => port.read({ kind: 'query', sql, params }) as Promise<TRow[]>),
		/** Resolves when queued work has run: the outbox is sent or the server unreachable, and live queries are current. */
		async flush() {
			await port.read({ kind: 'flush' });
			while (running.size > 0) await Promise.all(running);
		},
		close() {
			if (closed) return;
			closed = true;
			port.close();
		},
	};
}
export type Repository<TDefs extends Definitions> = ReturnType<typeof createRepository<TDefs>>;

/**
 * Open a repository whose engine runs in this thread, on any synchronous
 * driver: `bun:sqlite` in the CLI and tests, or a worker's own SQLite.
 */
export function openRepository<const TDefs extends Definitions>(options: EngineOptions<TDefs>) {
	const engine = openEngine(options);
	return createRepository(options.app, engine, { log: options.log });
}
