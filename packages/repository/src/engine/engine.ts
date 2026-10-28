/**
 * The device engine: one SQLite database per repository per device. It holds
 * every synced file's text and this device's unsent batches, answers reads
 * synchronously in SQL, applies writes locally at once, sends batches in
 * order, and rebases unsent edits with the Epicenter merge when the server
 * acknowledges them or reports other devices' changes.
 */
import { Check, Errors } from 'typebox/value';
import { createLogger, type Logger } from 'wellcrafted/logger';
import { defineErrors } from 'wellcrafted/error';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';
import type {
	App,
	BatchHandles,
	Definitions,
	Handles,
	Lens,
	NoteInput,
	Pending,
	Settled,
} from '../define.js';
import { WriteError } from '../define.js';
import { gitBlobHash, sha256 } from '../hash.js';
import { BODY_SQL, parseMarkdown, parsePointer, writeMarkdown, writePointer } from '../markdown.js';
import { merge } from '../merge.js';
import type { Batch, BatchOutcome, Broadcast, Change, ChangeOutcome, FileState, Move } from '../protocol.js';
import { first, type SqlDriver, type SqlValue } from '../sql.js';
import { buildPath, matchTemplate } from '../templates.js';
import { type BlobStore, createMemoryBlobStore, type Transport } from './ports.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS "epicenter/files" (
	path TEXT PRIMARY KEY,
	text TEXT,
	fields TEXT,
	body TEXT GENERATED ALWAYS AS (${BODY_SQL}) VIRTUAL,
	synced TEXT,
	hash TEXT,
	seq INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE TABLE IF NOT EXISTS "epicenter/outbox" (
	n INTEGER PRIMARY KEY,
	seq INTEGER NOT NULL,
	changes TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS "epicenter/meta" (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
`;

const PARSER_VERSION = '1';

const EngineDiagnostic = defineErrors({
	SyncStepFailed: ({ cause }: { cause: unknown }) => ({
		message: 'A sync step failed; it will run again on the next change or reconnect',
		cause,
	}),
	/** A batch the server did not apply; its local changes were reverted. */
	BatchNotApplied: ({ n, outcome }: { n: number; outcome: BatchOutcome }) => ({
		message: `Batch ${n} was not applied (${outcome.kind}); its local changes were reverted`,
		n,
		outcome,
	}),
});

/** One change as kept in the outbox: what was sent and what this device then showed. */
type Entry = { change: Change; local: string | null };

type FileRow = { path: string; text: string | null; synced: string | null; hash: string | null; seq: number };

export type Repository<TDefs extends Definitions> = Handles<TDefs> & {
	/**
	 * Build one batch from write-only handles; it lands all or nothing, except
	 * that each move is sent as a batch of its own.
	 */
	batch(build: (handles: BatchHandles<TDefs>) => void): Pending<Settled[]>;
	/** Run a read-only statement over the app's views. */
	query<TRow = Record<string, SqlValue>>(sql: string, params?: SqlValue[]): TRow[];
	/** Run a statement now and again after any change, calling back only when its rows differ. */
	live<TRow = Record<string, SqlValue>>(sql: string, params: SqlValue[], onChange: (rows: TRow[]) => void): () => void;
	/** Resolves when queued sync work has run: the outbox is sent, or the server is unreachable. */
	flush(): Promise<void>;
	close(): void;
};

export type RepositoryOptions<TDefs extends Definitions> = {
	app: App<TDefs>;
	driver: SqlDriver;
	transport: Transport;
	device: string;
	blobs?: BlobStore;
	log?: Logger;
};

const ROLLBACK = Symbol('rollback');

export function openRepository<const TDefs extends Definitions>({
	app,
	driver,
	transport,
	device,
	blobs = createMemoryBlobStore(),
	log = createLogger('repository/engine'),
}: RepositoryOptions<TDefs>): Repository<TDefs> {
	driver.exec(SCHEMA);
	const meta = (key: string) => first<{ value: string }>(driver, 'SELECT value FROM "epicenter/meta" WHERE key = ?', [key])?.value;
	const setMeta = (key: string, value: string) =>
		driver.run('INSERT OR REPLACE INTO "epicenter/meta" (key, value) VALUES (?, ?)', [key, value]);
	const stored = meta('device');
	// Opening another device's database is a wiring mistake, not a runtime condition.
	if (stored !== undefined && stored !== device)
		throw new Error(`This database belongs to device '${stored}', not '${device}'`);
	if (stored === undefined) {
		setMeta('device', device);
		setMeta('next', '1');
		setMeta('seq', '0');
		setMeta('ahead', '[]');
	}
	setMeta('parser', PARSER_VERSION);
	for (const lens of app.lenses) {
		driver.exec(`DROP VIEW IF EXISTS temp."${lens.name}"`);
		driver.exec(lens.view);
	}

	// ------------------------------------------------------------------------
	// Files
	// ------------------------------------------------------------------------

	const row = (path: string) =>
		first<FileRow>(driver, 'SELECT path, text, synced, hash, seq FROM "epicenter/files" WHERE path = ?', [path]);

	/** What the views read: a note's frontmatter, or a pointer's oid and size. */
	function fieldsOf(text: string | null): string | null {
		if (text === null) return null;
		const pointer = parsePointer(text);
		if (pointer !== null) return JSON.stringify(pointer);
		const parsed = parseMarkdown(text);
		return parsed.error === null ? JSON.stringify(parsed.data.fields) : null;
	}

	/** The one write path: text and its parsed fields in the same statement. */
	function put(path: string, next: Omit<FileRow, 'path'>) {
		if (next.text === null && next.synced === null) {
			driver.run('DELETE FROM "epicenter/files" WHERE path = ?', [path]);
			return;
		}
		driver.run(
			'INSERT OR REPLACE INTO "epicenter/files" (path, text, fields, synced, hash, seq) VALUES (?, ?, ?, ?, ?, ?)',
			[path, next.text, fieldsOf(next.text), next.synced, next.hash, next.seq],
		);
	}
	const keep = (path: string) => row(path) ?? { path, text: null, synced: null, hash: null, seq: 0 };

	/** Only Markdown files and LFS pointers live on devices. */
	const isDeviceFile = (path: string, text: string | null) =>
		path.endsWith('.md') || text === null || parsePointer(text) !== null;

	/** Unsent edits stay on top of what the server reports: local wins any overlap. */
	const rebaseLocal = (base: string | null, local: string | null, server: string | null) =>
		local === base ? server : merge(base, local, server).text;

	// ------------------------------------------------------------------------
	// Position: the highest server sequence below which nothing was missed
	// ------------------------------------------------------------------------

	const position = () => Number(meta('seq') ?? '0');
	function advance(seq: number) {
		let at = position();
		if (seq <= at) return;
		const ahead = new Set<number>(JSON.parse(meta('ahead') ?? '[]'));
		ahead.add(seq);
		while (ahead.has(at + 1)) ahead.delete(++at);
		setMeta('seq', String(at));
		setMeta('ahead', JSON.stringify([...ahead]));
	}
	function jumpTo(seq: number) {
		const at = Math.max(position(), seq);
		const ahead = (JSON.parse(meta('ahead') ?? '[]') as number[]).filter((s) => s > at);
		setMeta('seq', String(at));
		setMeta('ahead', JSON.stringify(ahead));
	}

	// ------------------------------------------------------------------------
	// Live queries
	// ------------------------------------------------------------------------

	type Live = { sql: string; params: SqlValue[]; onChange: (rows: never[]) => void; last: string };
	const lives = new Set<Live>();
	function notify() {
		for (const live of lives) {
			const rows = driver.all(live.sql, live.params);
			const json = JSON.stringify(rows);
			if (json === live.last) continue;
			live.last = json;
			live.onChange(rows as never[]);
		}
	}

	// ------------------------------------------------------------------------
	// Server changes
	// ------------------------------------------------------------------------

	function serverFile(file: FileState, seq: number, carried?: { base: string | null; local: string | null }) {
		if (!isDeviceFile(file.path, file.text)) return;
		const current = keep(file.path);
		if (current.seq > seq) return;
		const base = carried?.base ?? current.synced;
		const local = carried?.local ?? current.text;
		put(file.path, { text: rebaseLocal(base, local, file.text), synced: file.text, hash: file.hash, seq });
	}

	function receive(broadcast: Broadcast) {
		driver.transaction(() => {
			const carried = new Map<string, { base: string | null; local: string | null }>();
			for (const move of broadcast.moves) carryMove(move, carried);
			for (const file of broadcast.files) serverFile(file, broadcast.seq, carried.get(file.path));
			advance(broadcast.seq);
		});
		notify();
	}

	/** A move made elsewhere takes this device's unsent edits of the file along. */
	function carryMove({ from, to }: Move, carried: Map<string, { base: string | null; local: string | null }>) {
		const source = row(from);
		if (source === undefined || source.text === source.synced) return;
		carried.set(to, { base: source.synced, local: source.text });
		put(from, { ...source, text: null, synced: null, hash: null });
	}

	// ------------------------------------------------------------------------
	// Local changes and the outbox
	// ------------------------------------------------------------------------

	type Local = { kind: 'write'; path: string; text: string | null } | { kind: 'move'; from: string; to: string } | { kind: 'append'; path: string; text: string };

	/** Apply one change on this device and say what to send. Runs inside the batch's transaction. */
	function applyLocal(change: Local): Entry {
		// A move or append is made only to a file this device holds, so its base is that text.
		const baseOf = (text: string) => ({ hash: gitBlobHash(text), text });
		if (change.kind === 'move') {
			const source = keep(change.from);
			const destination = keep(change.to);
			put(change.from, { ...source, text: null });
			put(change.to, { ...destination, text: source.text });
			return { change: { ...change, base: baseOf(source.text ?? '') }, local: source.text };
		}
		const current = keep(change.path);
		if (change.kind === 'append') {
			const text = (current.text ?? '') + change.text;
			put(change.path, { ...current, text });
			return { change: { ...change, base: baseOf(current.text ?? '') }, local: text };
		}
		const base = current.text === null ? null : baseOf(current.text);
		put(change.path, { ...current, text: change.text });
		return { change: { kind: 'write', path: change.path, base, text: change.text }, local: change.text };
	}

	type Op = () => Result<Local, WriteError>;
	const waiters = new Map<number, (result: Result<Settled[], WriteError>) => void>();

	/**
	 * Apply ops locally and queue them, in one transaction. A move is sent as
	 * a batch of its own: the server may relocate or drop it, and later
	 * changes aimed at its destination should then follow it as their own
	 * batch, not ride along in its.
	 */
	function submit(ops: Op[]): Pending<Settled[]> {
		if (closed) return Promise.resolve(WriteError.Closed());
		let failure: WriteError | null = null;
		const numbers: number[] = [];
		try {
			driver.transaction(() => {
				const batches: Entry[][] = [];
				for (const op of ops) {
					const local = op();
					if (local.error !== null) {
						failure = local.error;
						throw ROLLBACK;
					}
					const entry = applyLocal(local.data);
					const last = batches.at(-1);
					if (last === undefined || entry.change.kind === 'move' || last[0]?.change.kind === 'move') batches.push([entry]);
					else last.push(entry);
				}
				for (const entries of batches) {
					const n = Number(meta('next') ?? '1');
					setMeta('next', String(n + 1));
					driver.run('INSERT INTO "epicenter/outbox" (n, seq, changes) VALUES (?, ?, ?)', [n, position(), JSON.stringify(entries)]);
					numbers.push(n);
				}
			});
		} catch (cause) {
			if (cause !== ROLLBACK) throw cause;
		}
		if (failure !== null) return Promise.resolve(Err(failure));
		notify();
		const parts = numbers.map((n) => new Promise<Result<Settled[], WriteError>>((resolve) => waiters.set(n, resolve)));
		kick();
		return Promise.all(parts).then((results) => {
			const settled: Settled[] = [];
			for (const result of results) {
				if (result.error !== null) return result;
				settled.push(...result.data);
			}
			return Ok(settled);
		});
	}

	/** Paths an outbox entry touches. */
	const pathsOf = ({ change }: Entry) => (change.kind === 'move' ? [change.from, change.to] : [change.path]);

	/** Whether an unsent batch other than `except` touches `path`. */
	function isPending(path: string, except: number) {
		const pending = driver.all<{ changes: string }>('SELECT changes FROM "epicenter/outbox" WHERE n <> ?', [except]);
		return pending.some((p) => (JSON.parse(p.changes) as Entry[]).some((e) => pathsOf(e).includes(path)));
	}

	/** Show the server's text again unless a later unsent change still covers the path. */
	function revert(path: string, except: number) {
		if (isPending(path, except)) return;
		const current = keep(path);
		put(path, { ...current, text: current.synced });
	}

	/**
	 * Fold the server's answer for one sent change into this device's files.
	 * With no later unsent change to the path, the server's text is the answer;
	 * otherwise the later edits are rebased onto it.
	 */
	function acknowledge(n: number, entry: Entry, outcome: ChangeOutcome, seq: number) {
		const { change, local: sent } = entry;
		const rebase = (path: string, local: string | null, server: string | null) =>
			isPending(path, n) ? rebaseLocal(sent, local, server) : server;
		const serverText = outcome.text !== undefined ? outcome.text : change.kind === 'write' ? change.text : null;
		const clash = outcome.overlaps.find((overlap) => overlap.unit === 'path');
		if (clash !== undefined && clash.clash !== 'taken') {
			// The change did not land where it was aimed, which may now hold a
			// different note: show the server's text there again, and the change
			// in the sibling the server made for it.
			for (const path of pathsOf(entry)) revert(path, n);
			if (outcome.at !== null) put(outcome.at, { text: serverText, synced: serverText, hash: outcome.hash, seq });
			return;
		}
		if (change.kind === 'move') {
			const source = keep(change.from);
			put(change.from, { ...source, synced: null, hash: null, seq });
			if (outcome.movedTo !== null) {
				const origin = keep(outcome.movedTo);
				if (origin.text === origin.synced) put(outcome.movedTo, { ...origin, text: null, synced: null, hash: null, seq });
			}
			// Onto a taken destination the note went to a sibling, and `to` holds the other note.
			const at = outcome.at ?? change.to;
			if (at !== change.to) revert(change.to, n);
			const destination = keep(at);
			const text = at === change.to ? rebase(at, destination.text, serverText) : serverText;
			put(at, { text, synced: serverText, hash: outcome.hash, seq });
			return;
		}
		if (outcome.at === null) {
			const current = keep(change.path);
			put(change.path, { text: isPending(change.path, n) ? current.text : null, synced: null, hash: null, seq });
			return;
		}
		const current = keep(change.path);
		if (outcome.movedTo !== null) {
			// The edit followed its note to `at`, by a move made elsewhere or to a
			// sibling the server made for it. The path it named shows the server's
			// text again: nothing after a move, a different note after a reuse.
			revert(change.path, n);
			put(outcome.at, { text: rebase(change.path, current.text, serverText), synced: serverText, hash: outcome.hash, seq });
			return;
		}
		put(change.path, { text: rebase(change.path, current.text, serverText), synced: serverText, hash: outcome.hash, seq });
	}

	function conclude(n: number, entries: Entry[], outcome: BatchOutcome) {
		let settled: Settled[];
		driver.transaction(() => {
			driver.run('DELETE FROM "epicenter/outbox" WHERE n = ?', [n]);
			if (outcome.kind === 'applied') {
				// With no seq the batch landed long ago, and the hello that came first
				// already brought what it did.
				if (outcome.seq === null) return;
				for (const [index, entry] of entries.entries()) {
					const change = outcome.changes[index];
					if (change !== undefined) acknowledge(n, entry, change, outcome.seq);
				}
				advance(outcome.seq);
				return;
			}
			// Nothing landed. A 'refuse' caller is told and still holds what it
			// wrote; the device shows the server's text again.
			for (const entry of entries) for (const path of pathsOf(entry)) revert(path, n);
		});
		switch (outcome.kind) {
			case 'applied':
				settled = entries.map((_, index) => ({ kind: 'applied', seq: outcome.seq, change: outcome.changes[index] ?? null }));
				break;
			case 'refused':
				settled = entries.map(() => ({ kind: 'refused', path: outcome.path, reason: outcome.reason }));
				break;
			case 'expired':
			case 'need-base':
				settled = entries.map(() => ({ kind: 'expired', paths: outcome.paths }));
				break;
		}
		if (outcome.kind !== 'applied') log.warn(EngineDiagnostic.BatchNotApplied({ n, outcome }));
		notify();
		waiters.get(n)?.(Ok(settled));
		waiters.delete(n);
	}

	// ------------------------------------------------------------------------
	// Sync: hello, then send the outbox in order, one batch in flight
	// ------------------------------------------------------------------------

	let closed = false;
	let online = true;
	let needsHello = true;
	let running: Promise<void> = Promise.resolve();
	const link = transport.connect({
		device,
		onBroadcast: (broadcast) => {
			if (!closed) receive(broadcast);
		},
		onOnline: () => {
			online = true;
			needsHello = true;
			kick();
		},
	});

	function kick(): Promise<void> {
		running = running.then(step).catch((cause: unknown) => {
			log.warn(EngineDiagnostic.SyncStepFailed({ cause }));
		});
		return running;
	}

	async function step() {
		if (closed || !online) return;
		if (needsHello) {
			const welcome = await link.hello(position());
			if (welcome.error !== null) {
				online = false;
				return;
			}
			needsHello = false;
			const { kind, seq, files } = welcome.data;
			driver.transaction(() => {
				if (kind === 'snapshot') {
					const present = new Set(files.map((file) => file.path));
					for (const { path } of driver.all<{ path: string }>('SELECT path FROM "epicenter/files" WHERE synced IS NOT NULL'))
						if (!present.has(path)) serverFile({ path, text: null, hash: null }, seq);
				}
				for (const file of files) serverFile(file, seq);
				jumpTo(seq);
			});
			notify();
		}
		for (;;) {
			if (closed) return;
			const next = first<{ n: number; seq: number; changes: string }>(
				driver,
				'SELECT n, seq, changes FROM "epicenter/outbox" ORDER BY n LIMIT 1',
			);
			if (next === undefined) return;
			const entries = JSON.parse(next.changes) as Entry[];
			const send = (withBases: boolean): Batch => ({
				device,
				n: next.n,
				seq: next.seq,
				changes: entries.map(({ change }): Change =>
					withBases || change.base === null ? change : { ...change, base: { hash: change.base.hash } },
				),
			});
			let answer = await link.push(send(false));
			if (answer.error === null && answer.data.kind === 'need-base') answer = await link.push(send(true));
			if (answer.error !== null) {
				online = false;
				needsHello = true;
				return;
			}
			const outcome: BatchOutcome =
				answer.data.kind === 'need-base'
					? { kind: 'refused', path: answer.data.paths[0] ?? '', reason: 'the server has no base for this change', overlaps: [] }
					: answer.data;
			conclude(next.n, entries, outcome);
		}
	}

	kick();

	// ------------------------------------------------------------------------
	// Handles
	// ------------------------------------------------------------------------

	/** A handle call's parameters and the rest of its arguments. */
	function split(lens: Lens, args: unknown[]): [Record<string, unknown>, unknown[]] {
		return lens.template.params.length === 0 ? [{}, args] : [(args[0] ?? {}) as Record<string, unknown>, args.slice(1)];
	}
	function pathOf(lens: Lens, params: Record<string, unknown>): Result<string, WriteError> {
		const built = buildPath(lens.template, params);
		return built.error === null ? Ok(built.data) : WriteError.InvalidParams({ handle: lens.name, reason: built.error.message });
	}
	const localText = (path: string) => row(path)?.text ?? null;

	function readNote(lens: Extract<Lens, { kind: 'note' }>, file: { path: string; text: string; fields: string | null; body: string }) {
		const params = matchTemplate(lens.template, file.path) ?? {};
		if (file.fields === null)
			return { path: file.path, params, text: file.text, body: file.body, valid: false, fields: {}, issues: ['The frontmatter does not parse'] };
		const fields = JSON.parse(file.fields) as Record<string, unknown>;
		if (Check(lens.schema, fields)) return { path: file.path, params, text: file.text, body: file.body, valid: true, fields };
		return {
			path: file.path,
			params,
			text: file.text,
			body: file.body,
			valid: false,
			fields,
			issues: Errors(lens.schema, fields).map((error) => `${error.instancePath || '/'} ${error.message}`),
		};
	}

	function listRows(lens: Lens, filter: Record<string, unknown> = {}) {
		const where = Object.entries(filter)
			.filter(([key, value]) => lens.template.params.includes(key) && value !== undefined)
			.map(([key]) => `v."${key}" = ?`);
		const params = Object.entries(filter)
			.filter(([key, value]) => lens.template.params.includes(key) && value !== undefined)
			.map(([, value]) => String(value));
		return driver.all<{ path: string; text: string; fields: string | null; body: string }>(
			`SELECT f.path, f.text, f.fields, f.body FROM "epicenter/files" f JOIN temp."${lens.name}" v ON v.path = f.path${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY f.path`,
			params,
		);
	}

	/** The ops a note handle builds: the same for a direct call and inside a batch. */
	function noteOps(lens: Extract<Lens, { kind: 'note' }>) {
		const edit = (args: unknown[], requireAbsent: boolean): Op => {
			const [params, [input]] = split(lens, args);
			return () => {
				const path = pathOf(lens, params);
				if (path.error !== null) return path;
				const current = localText(path.data);
				if (requireAbsent && current !== null) return WriteError.Exists({ path: path.data });
				const { fields, body } = (input ?? {}) as NoteInput<typeof lens.schema>;
				const text = writeMarkdown(current, { fields: fields as Record<string, unknown> | undefined, body });
				if (text.error !== null) return WriteError.Unparseable({ path: path.data, reason: text.error.reason });
				return Ok({ kind: 'write', path: path.data, text: text.data });
			};
		};
		return {
			create: (...args: unknown[]) => edit(args, true),
			write: (...args: unknown[]) => edit(args, false),
			set: (...args: unknown[]) => {
				const [params, [key, value]] = split(lens, args);
				return edit(lens.template.params.length === 0 ? [{ fields: { [String(key)]: value } }] : [params, { fields: { [String(key)]: value } }], false);
			},
			append: (...args: unknown[]): Op => {
				const [params, [text]] = split(lens, args);
				return () => {
					const path = pathOf(lens, params);
					if (path.error !== null) return path;
					if (localText(path.data) === null) return WriteError.NotFound({ path: path.data });
					return Ok({ kind: 'append', path: path.data, text: String(text) });
				};
			},
			move: (from: Record<string, unknown>, to: Record<string, unknown>) => moveOp(lens, from, to),
			delete: (...args: unknown[]) => deleteOp(lens, split(lens, args)[0]),
		};
	}

	function moveOp(lens: Lens, fromParams: Record<string, unknown>, toParams: Record<string, unknown>): Op {
		return () => {
			const from = pathOf(lens, fromParams);
			if (from.error !== null) return from;
			const to = pathOf(lens, toParams);
			if (to.error !== null) return to;
			if (localText(from.data) === null) return WriteError.NotFound({ path: from.data });
			if (localText(to.data) !== null) return WriteError.Exists({ path: to.data });
			return Ok({ kind: 'move', from: from.data, to: to.data });
		};
	}

	function deleteOp(lens: Lens, params: Record<string, unknown>): Op {
		return () => {
			const path = pathOf(lens, params);
			if (path.error !== null) return path;
			if (localText(path.data) === null) return WriteError.NotFound({ path: path.data });
			return Ok({ kind: 'write', path: path.data, text: null });
		};
	}

	/**
	 * A blob put: checks run first, the bytes are stored, and only then is the
	 * pointer op returned, so a pointer never names missing bytes.
	 */
	async function blobPut(lens: Extract<Lens, { kind: 'blob' }>, args: unknown[]): Promise<Result<Op, WriteError>> {
		const [params, [bytes, options]] = split(lens, args);
		const path = pathOf(lens, params);
		if (path.error !== null) return path;
		const data = bytes as Uint8Array;
		const type = (options as { type: string } | undefined)?.type ?? '';
		if (!lens.blob.types.includes(type))
			return WriteError.BlobRefused({ path: path.data, reason: `'${type}' is not one of ${lens.blob.types.join(', ')}` });
		if (lens.blob.maxSize !== undefined && data.length > lens.blob.maxSize)
			return WriteError.BlobRefused({ path: path.data, reason: `${data.length} bytes is over ${lens.blob.maxSize}` });
		const oid = await sha256(data);
		const stored = await tryAsync({
			try: () => blobs.put(oid, data, type),
			catch: (cause) => WriteError.BlobUploadFailed({ path: path.data, cause }),
		});
		if (stored.error !== null) return stored;
		const pointer = writePointer({ oid, size: data.length });
		return Ok(() => Ok({ kind: 'write', path: path.data, text: pointer }));
	}

	const single = async (pending: Pending<Settled[]>): Pending => {
		const result = await pending;
		if (result.error !== null) return result;
		const [settled] = result.data;
		return settled === undefined ? WriteError.Closed() : Ok(settled);
	};

	const handles: Record<string, unknown> = {};
	for (const lens of app.lenses) {
		if (lens.kind === 'note') {
			const ops = noteOps(lens);
			handles[lens.name] = {
				get: (...args: unknown[]) => {
					const path = buildPath(lens.template, split(lens, args)[0]);
					if (path.error !== null) return null;
					const file = first<{ path: string; text: string; fields: string | null; body: string }>(
						driver,
						'SELECT path, text, fields, body FROM "epicenter/files" WHERE path = ? AND text IS NOT NULL',
						[path.data],
					);
					return file === undefined ? null : readNote(lens, file);
				},
				list: (filter?: Record<string, unknown>) => listRows(lens, filter).map((file) => readNote(lens, file)),
				create: (...args: unknown[]) => single(submit([ops.create(...args)])),
				write: (...args: unknown[]) => single(submit([ops.write(...args)])),
				set: (...args: unknown[]) => single(submit([ops.set(...args)])),
				append: (...args: unknown[]) => single(submit([ops.append(...args)])),
				move: (from: Record<string, unknown>, to: Record<string, unknown>) => single(submit([ops.move(from, to)])),
				delete: (...args: unknown[]) => single(submit([ops.delete(...args)])),
			};
			continue;
		}
		const pointerOf = (args: unknown[]) => {
			const path = buildPath(lens.template, split(lens, args)[0]);
			const text = path.error === null ? localText(path.data) : null;
			return text === null ? null : parsePointer(text);
		};
		handles[lens.name] = {
			put: async (...args: unknown[]) => {
				const op = await blobPut(lens, args);
				return op.error !== null ? op : single(submit([op.data]));
			},
			get: async (...args: unknown[]) => {
				const pointer = pointerOf(args);
				return pointer === null ? null : blobs.get(pointer.oid);
			},
			url: async (...args: unknown[]) => {
				const pointer = pointerOf(args);
				return pointer === null ? null : blobs.url(pointer.oid);
			},
			list: (filter?: Record<string, unknown>) =>
				listRows(lens, filter).flatMap((file) => {
					const pointer = parsePointer(file.text);
					return pointer === null ? [] : [{ path: file.path, params: matchTemplate(lens.template, file.path) ?? {}, ...pointer }];
				}),
			delete: (...args: unknown[]) => single(submit([deleteOp(lens, split(lens, args)[0])])),
		};
	}

	return {
		...(handles as Handles<TDefs>),
		async batch(build) {
			const ops: (Op | Promise<Result<Op, WriteError>>)[] = [];
			const batchHandles: Record<string, unknown> = {};
			for (const lens of app.lenses) {
				if (lens.kind === 'note') {
					const note = noteOps(lens);
					batchHandles[lens.name] = {
						create: (...args: unknown[]) => void ops.push(note.create(...args)),
						write: (...args: unknown[]) => void ops.push(note.write(...args)),
						set: (...args: unknown[]) => void ops.push(note.set(...args)),
						append: (...args: unknown[]) => void ops.push(note.append(...args)),
						move: (from: Record<string, unknown>, to: Record<string, unknown>) => void ops.push(note.move(from, to)),
						delete: (...args: unknown[]) => void ops.push(note.delete(...args)),
					};
				} else
					batchHandles[lens.name] = {
						put: (...args: unknown[]) => void ops.push(blobPut(lens, args)),
						delete: (...args: unknown[]) => void ops.push(deleteOp(lens, split(lens, args)[0])),
					};
			}
			build(batchHandles as BatchHandles<TDefs>);
			const ready: Op[] = [];
			for (const op of ops) {
				if (typeof op === 'function') {
					ready.push(op);
					continue;
				}
				const resolved = await op;
				if (resolved.error !== null) return resolved;
				ready.push(resolved.data);
			}
			return submit(ready);
		},
		query: (sql, params = []) => driver.all(sql, params),
		live(sql, params, onChange) {
			const rows = driver.all(sql, params);
			const live: Live = { sql, params, onChange: onChange as (rows: never[]) => void, last: JSON.stringify(rows) };
			lives.add(live);
			onChange(rows as never[]);
			return () => {
				lives.delete(live);
			};
		},
		flush: () => running,
		close() {
			closed = true;
			link.close();
			lives.clear();
			for (const resolve of waiters.values()) resolve(WriteError.Closed());
			waiters.clear();
		},
	};
}
