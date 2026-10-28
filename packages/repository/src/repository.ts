/**
 * The app API, the same for every host: reads and live queries are
 * asynchronous, writes apply on the device before they return and resolve
 * when the server answers, and an open note reads synchronously.
 *
 * `createRepository` builds it over an `EnginePort`: the engine itself in
 * the caller's thread (`openRepository`, used by Bun and tests), or a browser
 * tab's connection to the leader's worker (`openBrowserRepository`).
 */
import { Check, Errors } from 'typebox/value';
import { defineErrors } from 'wellcrafted/error';
import { createLogger, type Logger } from 'wellcrafted/logger';
import { Ok } from 'wellcrafted/result';
import type {
	App,
	BatchHandles,
	BlobEntry,
	Definitions,
	Handles,
	Lens,
	Live,
	Pending,
	Settled,
} from './define.js';
import { WriteError } from './define.js';
import {
	type EngineAnswers,
	type EngineOptions,
	type EngineRequest,
	type FileRead,
	openEngine,
	type Submitted,
	type WriteOp,
} from './engine/engine.js';
import { parseMarkdown, parsePointer, splitMarkdown, writeMarkdown } from './markdown.js';
import type { SqlValue } from './sql.js';
import { buildPath, matchTemplate } from './templates.js';

/** What the app API needs from wherever the engine runs. */
export type EnginePort = {
	read<TRequest extends EngineRequest>(request: TRequest): Promise<EngineAnswers[TRequest['kind']]>;
	/** Run a command's writes under its id; a command id already seen is answered, not repeated. */
	submit(command: string, ops: WriteOp[]): Submitted;
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

/** A note read from a file row. Fields that fail the schema are returned raw, with issues. */
function noteOf(lens: Extract<Lens, { kind: 'note' }>, file: FileRead) {
	const params = matchTemplate(lens.template, file.path) ?? {};
	const base = { path: file.path, params, text: file.text, body: file.body };
	if (file.fields === null) return { ...base, valid: false, fields: {}, issues: ['The frontmatter does not parse'] };
	const fields = JSON.parse(file.fields) as Record<string, unknown>;
	if (Check(lens.schema, fields)) return { ...base, valid: true, fields };
	return {
		...base,
		valid: false,
		fields,
		issues: Errors(lens.schema, fields).map((error) => `${error.instancePath || '/'} ${error.message}`),
	};
}

/** The same row, computed from text this client holds: what an open note shows before the engine answers. */
function fileOf(path: string, text: string): FileRead {
	const parsed = parseMarkdown(text);
	return {
		path,
		text,
		fields: parsed.error === null ? JSON.stringify(parsed.data.fields) : null,
		body: text.slice(splitMarkdown(text).bodyStart),
	};
}

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

	const submit = (ops: WriteOp[]) => port.submit(crypto.randomUUID(), ops);
	const first = async (pending: Pending<Settled[]>): Pending => {
		const result = await pending;
		if (result.error !== null) return result;
		const [settled] = result.data;
		return settled === undefined ? WriteError.Closed() : Ok(settled);
	};
	const send = (op: WriteOp) => first(submit([op]).settled);

	/** A handle call's parameters and the rest of its arguments. */
	const split = (lens: Lens, args: unknown[]): [Params, unknown[]] =>
		lens.template.params.length === 0 ? [{}, args] : [(args[0] ?? {}) as Params, args.slice(1)];

	/** The ops a note handle builds: the same for a direct call and inside a batch. */
	function noteOps(lens: Extract<Lens, { kind: 'note' }>) {
		const name = lens.name;
		return {
			create: (...args: unknown[]): WriteOp => {
				const [params, [input]] = split(lens, args);
				return { kind: 'create', name, params, input: (input ?? {}) as NoteChange };
			},
			write: (...args: unknown[]): WriteOp => {
				const [params, [input]] = split(lens, args);
				return { kind: 'write', name, params, input: (input ?? {}) as NoteChange };
			},
			set: (...args: unknown[]): WriteOp => {
				const [params, [key, value]] = split(lens, args);
				return { kind: 'set', name, params, key: String(key), value };
			},
			append: (...args: unknown[]): WriteOp => {
				const [params, [text]] = split(lens, args);
				return { kind: 'append', name, params, text: String(text) };
			},
			move: (...[from, to]: unknown[]): WriteOp => ({ kind: 'move', name, from: from as Params, to: to as Params }),
			delete: (...args: unknown[]): WriteOp => ({ kind: 'delete', name, params: split(lens, args)[0] }),
		};
	}

	function blobOps(lens: Extract<Lens, { kind: 'blob' }>) {
		return {
			put: (...args: unknown[]): WriteOp => {
				const [params, [bytes, options]] = split(lens, args);
				return { kind: 'put', name: lens.name, params, bytes: bytes as Uint8Array, type: (options as { type?: string } | undefined)?.type ?? '' };
			},
			delete: (...args: unknown[]): WriteOp => ({ kind: 'delete', name: lens.name, params: split(lens, args)[0] }),
		};
	}

	/**
	 * Hold one note open. It shows writes made through it at once, keeps
	 * showing them while they are applied, and otherwise reads again whenever
	 * the engine reports its path changed.
	 */
	async function open(lens: Extract<Lens, { kind: 'note' }>, params: Params) {
		const built = buildPath(lens.template, params);
		const path = built.error === null ? built.data : null;
		const ops = noteOps(lens);
		const readFile = () => (path === null ? Promise.resolve(null) : port.read({ kind: 'get', name: lens.name, params }));
		let shown: FileRead | null = await readFile();
		let note = shown === null ? null : noteOf(lens, shown);
		/** Writes through this handle not yet applied by the engine. */
		let applying = 0;
		/** Bumped by every write, so a read that a write overtook is dropped. */
		let generation = 0;
		const listeners = new Set<(note: unknown) => void>();
		const show = (next: FileRead | null) => {
			if ((next?.text ?? null) === (shown?.text ?? null)) return;
			shown = next;
			note = next === null ? null : noteOf(lens, next);
			for (const listener of listeners) listener(note);
		};
		const refresh = async () => {
			const at = generation;
			const next = await readFile();
			if (at === generation && applying === 0) show(next);
		};
		const stop = port.onChange((paths) => {
			if (path !== null && (paths === null || paths.includes(path)) && applying === 0) track(refresh());
		});

		/** Show the write's text now, then the engine's once it has applied every write made here. */
		function through(op: WriteOp, text: string | null): Pending {
			if (path === null) return Promise.resolve(WriteError.InvalidParams({ handle: lens.name, reason: 'the parameters build no path' }));
			generation++;
			applying++;
			show(text === null ? null : fileOf(path, text));
			const { local, settled } = submit([op]);
			track(
				local.then(() => {
					applying--;
					if (applying === 0) return refresh();
				}),
			);
			return first(settled);
		}
		/** The text a write leaves, as the engine computes it; an unparseable note is the engine's to refuse. */
		const written = (change: Parameters<typeof writeMarkdown>[1]) => {
			const text = writeMarkdown(shown?.text ?? null, change);
			return text.error === null ? text.data : (shown?.text ?? null);
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
			set: (key: string, value: unknown) => through(ops.set(...args(key, value)), written({ fields: { [key]: value } })),
			append: (text: string) => through(ops.append(...args(text)), shown === null ? null : shown.text + text),
			delete: () => through(ops.delete(...args()), null),
			close() {
				stop();
				listeners.clear();
			},
		};
	}

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
				create: (...args: unknown[]) => send(ops.create(...args)),
				write: (...args: unknown[]) => send(ops.write(...args)),
				set: (...args: unknown[]) => send(ops.set(...args)),
				append: (...args: unknown[]) => send(ops.append(...args)),
				move: (from: Params, to: Params) => send(ops.move(from, to)),
				delete: (...args: unknown[]) => send(ops.delete(...args)),
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
			put: (...args: unknown[]) => send(ops.put(...args)),
			get: (...args: unknown[]) => port.read({ kind: 'blob', name, params: split(lens, args)[0], as: 'bytes' }),
			url: (...args: unknown[]) => port.read({ kind: 'blob', name, params: split(lens, args)[0], as: 'url' }),
			list,
			live: (filter?: Params) => liveOf(() => list(filter)),
			delete: (...args: unknown[]) => send(ops.delete(...args)),
		};
	}

	return {
		...(handles as Handles<TDefs>),
		/**
		 * Build one batch from write-only handles; it lands all or nothing, except
		 * that each move is sent as a batch of its own.
		 */
		batch(build: (handles: BatchHandles<TDefs>) => void): Pending<Settled[]> {
			const ops: WriteOp[] = [];
			const batchHandles: Record<string, Record<string, (...args: never[]) => void>> = {};
			for (const lens of app.lenses) {
				const made: Record<string, (...args: unknown[]) => WriteOp> = lens.kind === 'note' ? noteOps(lens) : blobOps(lens);
				batchHandles[lens.name] = Object.fromEntries(
					Object.entries(made).map(([verb, make]) => [verb, (...args: unknown[]) => void ops.push(make(...args))]),
				);
			}
			build(batchHandles as BatchHandles<TDefs>);
			return submit(ops).settled;
		},
		/** Run a read-only statement over the app's views and the engine's tables. */
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
