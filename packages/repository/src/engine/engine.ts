/**
 * The device engine: one SQLite database per repository per device. It holds
 * every synced file's text and this device's unsent batches, answers reads in
 * SQL, applies writes locally at once, sends batches in order, and rebases
 * unsent edits with the Epicenter merge when the server acknowledges them or
 * reports other devices' changes.
 *
 * Everything it takes and returns is plain data (`EngineRequest`, `WriteOp`),
 * so it runs in the caller's thread (`openRepository`) or in a browser worker
 * that serves several tabs; `createRepository` turns it into the app API.
 */
import { createLogger, type Logger } from 'wellcrafted/logger';
import { defineErrors } from 'wellcrafted/error';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';
import type { App, Definitions, Lens, Settled } from '../define.js';
import { WriteError } from '../define.js';
import { gitBlobHash, sha256 } from '../hash.js';
import { BODY_SQL, parseMarkdown, parsePointer, writeMarkdown, writePointer } from '../markdown.js';
import { merge } from '../merge.js';
import type { Batch, BatchOutcome, Broadcast, Change, ChangeOutcome, FileState, Move } from '../protocol.js';
import { first, type SqlDriver, type SqlValue } from '../sql.js';
import { buildPath } from '../templates.js';
import { type BlobStore, createMemoryBlobStore, type Transport } from './ports.js';

/** The function that parses a file's fields, registered where the driver can. */
const FIELDS_FUNCTION = 'epicenter_fields';

const schema = (computedFields: boolean) => `
CREATE TABLE IF NOT EXISTS "epicenter/files" (
	path TEXT PRIMARY KEY,
	text TEXT,
	fields TEXT${computedFields ? ` GENERATED ALWAYS AS (${FIELDS_FUNCTION}(text)) STORED` : ''},
	body TEXT GENERATED ALWAYS AS (${BODY_SQL}) VIRTUAL,
	synced TEXT,
	hash TEXT,
	seq INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE TABLE IF NOT EXISTS "epicenter/outbox" (
	n INTEGER PRIMARY KEY,
	seq INTEGER NOT NULL,
	changes TEXT NOT NULL,
	outcome TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS "epicenter/commands" (
	command TEXT NOT NULL,
	n INTEGER NOT NULL,
	PRIMARY KEY (command, n)
) STRICT;
CREATE INDEX IF NOT EXISTS "epicenter/commands_n" ON "epicenter/commands" (n);
CREATE TABLE IF NOT EXISTS "epicenter/meta" (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
`;

/**
 * How many settled outbox rows stay, so that a command retried after its
 * answer was lost (a leader tab closing) is found rather than repeated.
 */
const KEEP_SETTLED = 500;

const PARSER_VERSION = '1';

/** Why a change the server still lacks a base for, after it was resent with its bases, did not land. */
const NO_BASE = 'the server has no base for this change';

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

/** A file as reads return it: its text, the parsed fields as JSON (null when they do not parse) and the body. */
export type FileRead = { path: string; text: string; fields: string | null; body: string };

type Params = Record<string, unknown>;

/** One write an app asks for, as data, so it can cross to a worker and be retried. */
export type WriteOp =
	| { kind: 'create' | 'write'; name: string; params: Params; input: { fields?: Record<string, unknown>; body?: string } }
	| { kind: 'set'; name: string; params: Params; key: string; value: unknown }
	| { kind: 'append'; name: string; params: Params; text: string }
	| { kind: 'move'; name: string; from: Params; to: Params }
	| { kind: 'delete'; name: string; params: Params }
	| { kind: 'put'; name: string; params: Params; bytes: Uint8Array; type: string };

/** A read, as data. */
export type EngineRequest =
	| { kind: 'get'; name: string; params: Params }
	| { kind: 'list'; name: string; filter: Params }
	| { kind: 'query'; sql: string; params: SqlValue[] }
	| { kind: 'blob'; name: string; params: Params; as: 'bytes' | 'url' }
	/** Resolves when queued sync work has run: the outbox is sent, or the server is unreachable. */
	| { kind: 'flush' };

/** What each read answers. */
export type EngineAnswers = {
	get: FileRead | null;
	list: FileRead[];
	query: Record<string, SqlValue>[];
	blob: Uint8Array | string | null;
	flush: undefined;
};

/**
 * A submitted command: `local` settles once its writes are applied on this
 * device (or refused there), `settled` once the server answers each batch.
 */
export type Submitted = {
	local: Promise<Result<undefined, WriteError>>;
	settled: Promise<Result<Settled[], WriteError>>;
};

export type EngineOptions<TDefs extends Definitions> = {
	app: App<TDefs>;
	driver: SqlDriver;
	transport: Transport;
	/** This device's id; by default the one the database holds, or a new one. */
	device?: string;
	blobs?: BlobStore;
	log?: Logger;
};

const ROLLBACK = Symbol('rollback');

export function openEngine<const TDefs extends Definitions>({
	app,
	driver,
	transport,
	device: requested,
	blobs = createMemoryBlobStore(),
	log = createLogger('repository/engine'),
}: EngineOptions<TDefs>) {
	/** What the views read: a note's frontmatter, or a pointer's oid and size. */
	function fieldsOf(text: string | null): string | null {
		if (text === null) return null;
		const pointer = parsePointer(text);
		if (pointer !== null) return JSON.stringify(pointer);
		const parsed = parseMarkdown(text);
		return parsed.error === null ? JSON.stringify(parsed.data.fields) : null;
	}
	// Where the driver can register a function, SQLite computes `fields` from
	// the text itself; otherwise every write stores both in one statement.
	const computedFields = driver.registerFunction !== undefined;
	driver.registerFunction?.(FIELDS_FUNCTION, (text) => fieldsOf(typeof text === 'string' ? text : null));
	driver.exec(schema(computedFields));

	const meta = (key: string) => first<{ value: string }>(driver, 'SELECT value FROM "epicenter/meta" WHERE key = ?', [key])?.value;
	const setMeta = (key: string, value: string) =>
		driver.run('INSERT OR REPLACE INTO "epicenter/meta" (key, value) VALUES (?, ?)', [key, value]);
	const stored = meta('device');
	// Opening another device's database is a wiring mistake, not a runtime condition.
	if (stored !== undefined && requested !== undefined && stored !== requested)
		throw new Error(`This database belongs to device '${stored}', not '${requested}'`);
	const device = stored ?? requested ?? crypto.randomUUID();
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
	const lenses = new Map(app.lenses.map((lens) => [lens.name, lens]));

	// ------------------------------------------------------------------------
	// Files
	// ------------------------------------------------------------------------

	const row = (path: string) =>
		first<FileRow>(driver, 'SELECT path, text, synced, hash, seq FROM "epicenter/files" WHERE path = ?', [path]);

	/** Paths whose shown text changed since the last notification. */
	const changed = new Set<string>();

	/** The one write path: text and its parsed fields in the same statement. */
	function put(path: string, next: Omit<FileRow, 'path'>) {
		if ((row(path)?.text ?? null) !== next.text) changed.add(path);
		if (next.text === null && next.synced === null) {
			driver.run('DELETE FROM "epicenter/files" WHERE path = ?', [path]);
			return;
		}
		if (computedFields)
			driver.run('INSERT OR REPLACE INTO "epicenter/files" (path, text, synced, hash, seq) VALUES (?, ?, ?, ?, ?)', [
				path,
				next.text,
				next.synced,
				next.hash,
				next.seq,
			]);
		else
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
	// Change notifications
	// ------------------------------------------------------------------------

	const listeners = new Set<(paths: string[]) => void>();
	function notify() {
		if (changed.size === 0) return;
		const paths = [...changed];
		changed.clear();
		for (const listener of listeners) listener(paths);
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
			return { change, local: source.text };
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

	/** Every op but a blob put, whose bytes are stored first and which then writes its pointer's text. */
	type Ready = Exclude<WriteOp, { kind: 'put' }> | { kind: 'pointer'; name: string; params: Params; text: string };

	function pathOf(lens: Lens, params: Params): Result<string, WriteError> {
		const built = buildPath(lens.template, params);
		return built.error === null ? Ok(built.data) : WriteError.InvalidParams({ handle: lens.name, reason: built.error.message });
	}
	function lensOf(name: string): Lens {
		const lens = lenses.get(name);
		// The client builds ops only from the app's own names.
		if (lens === undefined) throw new Error(`'${name}' is not a name in this app`);
		return lens;
	}
	const localText = (path: string) => row(path)?.text ?? null;

	/** What one op does on this device, read against what the device shows now. */
	function resolve(op: Ready): Result<Local, WriteError> {
		const lens = lensOf(op.name);
		if (op.kind === 'move') {
			const from = pathOf(lens, op.from);
			if (from.error !== null) return from;
			const to = pathOf(lens, op.to);
			if (to.error !== null) return to;
			if (localText(from.data) === null) return WriteError.NotFound({ path: from.data });
			if (localText(to.data) !== null) return WriteError.Exists({ path: to.data });
			return Ok({ kind: 'move', from: from.data, to: to.data });
		}
		const path = pathOf(lens, op.params);
		if (path.error !== null) return path;
		const current = localText(path.data);
		switch (op.kind) {
			case 'pointer':
				return Ok({ kind: 'write', path: path.data, text: op.text });
			case 'delete':
				if (current === null) return WriteError.NotFound({ path: path.data });
				return Ok({ kind: 'write', path: path.data, text: null });
			case 'append':
				if (current === null) return WriteError.NotFound({ path: path.data });
				return Ok({ kind: 'append', path: path.data, text: op.text });
			case 'create':
			case 'write':
			case 'set': {
				if (op.kind === 'create' && current !== null) return WriteError.Exists({ path: path.data });
				const change = op.kind === 'set' ? { fields: { [op.key]: op.value } } : op.input;
				const text = writeMarkdown(current, change);
				if (text.error !== null) return WriteError.Unparseable({ path: path.data, reason: text.error.reason });
				return Ok({ kind: 'write', path: path.data, text: text.data });
			}
		}
	}

	/**
	 * A blob put: checks run first, the bytes are stored, and only then is the
	 * pointer op returned, so a pointer never names missing bytes.
	 */
	async function upload(op: Extract<WriteOp, { kind: 'put' }>): Promise<Result<Ready, WriteError>> {
		const lens = lensOf(op.name);
		const path = pathOf(lens, op.params);
		if (path.error !== null) return path;
		if (lens.kind !== 'blob') throw new Error(`'${op.name}' is not a blob name`);
		if (!lens.blob.types.includes(op.type))
			return WriteError.BlobRefused({ path: path.data, reason: `'${op.type}' is not one of ${lens.blob.types.join(', ')}` });
		if (lens.blob.maxSize !== undefined && op.bytes.length > lens.blob.maxSize)
			return WriteError.BlobRefused({ path: path.data, reason: `${op.bytes.length} bytes is over ${lens.blob.maxSize}` });
		const oid = await sha256(op.bytes);
		const stored = await tryAsync({
			try: () => blobs.put(oid, op.bytes, op.type),
			catch: (cause) => WriteError.BlobUploadFailed({ path: path.data, cause }),
		});
		if (stored.error !== null) return stored;
		return Ok({ kind: 'pointer', name: op.name, params: op.params, text: writePointer({ oid, size: op.bytes.length }) });
	}

	const waiters = new Map<number, ((result: Result<Settled[], WriteError>) => void)[]>();
	const wait = (n: number) =>
		new Promise<Result<Settled[], WriteError>>((resolve) => waiters.set(n, [...(waiters.get(n) ?? []), resolve]));

	/** One answer for a command from its outbox rows, settled or still waiting. */
	function settledOf(rows: { n: number; outcome: string | null }[]): Promise<Result<Settled[], WriteError>> {
		const parts = rows.map(({ n, outcome }) => (outcome === null ? wait(n) : Promise.resolve(Ok(JSON.parse(outcome) as Settled[]))));
		return Promise.all(parts).then((results) => {
			const settled: Settled[] = [];
			for (const result of results) {
				if (result.error !== null) return result;
				settled.push(...result.data);
			}
			return Ok(settled);
		});
	}

	const commandRows = (command: string) =>
		driver.all<{ n: number; outcome: string | null }>(
			'SELECT o.n, o.outcome FROM "epicenter/commands" c JOIN "epicenter/outbox" o ON o.n = c.n WHERE c.command = ? ORDER BY o.n',
			[command],
		);

	/** The highest batch number ever handed to the transport: a batch at or below it may have reached the server. */
	const sentThrough = () => Number(meta('sent') ?? '0');

	/**
	 * The last outbox row, when a write to `path` can take its place: the row
	 * is unsent and was never handed to the transport, and it holds exactly
	 * one write to `path` that leaves text. A delete keeps its own row, so a
	 * delete and a recreate never become one edit.
	 */
	function coalescible(path: string): { n: number; entry: Entry } | undefined {
		const last = first<{ n: number; changes: string; outcome: string | null }>(
			driver,
			'SELECT n, changes, outcome FROM "epicenter/outbox" ORDER BY n DESC LIMIT 1',
		);
		if (last === undefined || last.outcome !== null || last.n <= sentThrough()) return undefined;
		const entries = JSON.parse(last.changes) as Entry[];
		const [entry] = entries;
		if (entries.length !== 1 || entry === undefined) return undefined;
		const { change } = entry;
		if (change.kind !== 'write' || change.path !== path || change.text === null) return undefined;
		return { n: last.n, entry };
	}

	/**
	 * Queue a command's batches under its id and answer their numbers. A
	 * command that is one write leaving text, to the path the last unsent
	 * write names, replaces that write's text instead of adding a row; the
	 * base stays the text the first write started from. Typing then sends one
	 * batch per send rather than one per keystroke, and a retry of any of
	 * those commands is answered by the one row.
	 */
	function queue(command: string, batches: Entry[][]): number[] {
		const only = batches.length === 1 && batches[0]?.length === 1 ? batches[0][0] : undefined;
		const into = only?.change.kind === 'write' && only.change.text !== null ? coalescible(only.change.path) : undefined;
		if (only !== undefined && into !== undefined && into.entry.change.kind === 'write') {
			const replaced: Entry = { change: { ...into.entry.change, text: only.local }, local: only.local };
			driver.run('UPDATE "epicenter/outbox" SET changes = ? WHERE n = ?', [JSON.stringify([replaced]), into.n]);
			driver.run('INSERT INTO "epicenter/commands" (command, n) VALUES (?, ?)', [command, into.n]);
			return [into.n];
		}
		return batches.map((entries) => {
			const n = Number(meta('next') ?? '1');
			setMeta('next', String(n + 1));
			driver.run('INSERT INTO "epicenter/outbox" (n, seq, changes) VALUES (?, ?, ?)', [n, position(), JSON.stringify(entries)]);
			driver.run('INSERT INTO "epicenter/commands" (command, n) VALUES (?, ?)', [command, n]);
			return n;
		});
	}

	/**
	 * Apply ops locally and queue them, in one transaction, under the
	 * caller's command id: a command already in the outbox is answered from
	 * there and never applied twice. A move is sent as a batch of its own: the
	 * server refuses it when its destination is taken, and that refusal should
	 * undo only the move, not the changes around it.
	 */
	function apply(command: string, ops: Ready[]): Submitted {
		if (closed) return { local: Promise.resolve(WriteError.Closed()), settled: Promise.resolve(WriteError.Closed()) };
		const known = commandRows(command);
		if (known.length > 0) return { local: Promise.resolve(Ok(undefined)), settled: settledOf(known) };
		let failure: WriteError | null = null;
		let numbers: number[] = [];
		try {
			driver.transaction(() => {
				const batches: Entry[][] = [];
				for (const op of ops) {
					const local = resolve(op);
					if (local.error !== null) {
						failure = local.error;
						throw ROLLBACK;
					}
					const entry = applyLocal(local.data);
					const last = batches.at(-1);
					if (last === undefined || entry.change.kind === 'move' || last[0]?.change.kind === 'move') batches.push([entry]);
					else last.push(entry);
				}
				numbers = queue(command, batches);
			});
		} catch (cause) {
			if (cause !== ROLLBACK) throw cause;
			changed.clear();
		}
		if (failure !== null) return { local: Promise.resolve(Err(failure)), settled: Promise.resolve(Err(failure)) };
		notify();
		const settled = settledOf(numbers.map((n) => ({ n, outcome: null })));
		kick();
		return { local: Promise.resolve(Ok(undefined)), settled };
	}

	function submit(command: string, ops: WriteOp[]): Submitted {
		if (!ops.some((op) => op.kind === 'put')) return apply(command, ops as Ready[]);
		const ready = (async (): Promise<Result<Ready[], WriteError>> => {
			const out: Ready[] = [];
			for (const op of ops) {
				if (op.kind !== 'put') {
					out.push(op);
					continue;
				}
				const uploaded = await upload(op);
				if (uploaded.error !== null) return uploaded;
				out.push(uploaded.data);
			}
			return Ok(out);
		})();
		const submitted = ready.then((result) => (result.error !== null ? { local: Promise.resolve(result), settled: Promise.resolve(result) } : apply(command, result.data)));
		return {
			local: submitted.then((s) => s.local).then((r) => (r.error !== null ? Err(r.error) : Ok(undefined))),
			settled: submitted.then((s) => s.settled),
		};
	}

	/** The paths an outbox entry touches. */
	const pathsOf = ({ change }: Entry) => (change.kind === 'move' ? [change.from, change.to] : [change.path]);

	const unsent = (except = -1) =>
		driver.all<{ n: number; changes: string }>('SELECT n, changes FROM "epicenter/outbox" WHERE outcome IS NULL AND n <> ? ORDER BY n', [except]);

	/** Whether an unsent batch other than `except` touches `path`. */
	const isPending = (path: string, except: number) =>
		unsent(except).some((p) => (JSON.parse(p.changes) as Entry[]).some((e) => pathsOf(e).includes(path)));

	/** Show the server's text again unless a later unsent change still covers the path. */
	function revert(path: string, except: number) {
		if (isPending(path, except)) return;
		const current = keep(path);
		put(path, { ...current, text: current.synced });
	}

	/**
	 * A refused move puts its note back at `from`, as this device shows it,
	 * and later unsent changes aimed at `to` are aimed at `from` again, so
	 * they reach the note and never the one that took `to`. When a later
	 * change also names `from`, only the server's texts are shown again.
	 */
	function putBack({ from, to }: { from: string; to: string }) {
		const entries = unsent().map((batch) => ({ n: batch.n, entries: JSON.parse(batch.changes) as Entry[] }));
		if (entries.some((batch) => batch.entries.some((entry) => pathsOf(entry).includes(from)))) {
			for (const path of [from, to]) revert(path, -1);
			return;
		}
		const moved = keep(to);
		put(from, { ...keep(from), text: moved.text });
		put(to, { ...moved, text: moved.synced });
		const aimed = (path: string) => (path === to ? from : path);
		for (const batch of entries) {
			const retargeted = batch.entries.map(({ change, local }): Entry => ({
				local,
				change: change.kind === 'move' ? { ...change, from: aimed(change.from) } : { ...change, path: aimed(change.path) },
			}));
			driver.run('UPDATE "epicenter/outbox" SET changes = ? WHERE n = ?', [JSON.stringify(retargeted), batch.n]);
		}
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
		if (clash !== undefined) {
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
			const destination = keep(change.to);
			put(change.to, { text: rebase(change.to, destination.text, serverText), synced: serverText, hash: outcome.hash, seq });
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

	/**
	 * Settle one batch. Its row stays, holding the outcome, so a command
	 * retried by id after its answer was lost gets that outcome again; the
	 * oldest settled rows are dropped.
	 */
	function conclude(n: number, entries: Entry[], outcome: BatchOutcome) {
		let settled: Settled[];
		switch (outcome.kind) {
			case 'applied':
				settled = entries.map((_, index) => ({ kind: 'applied', seq: outcome.seq, change: outcome.changes[index] ?? null }));
				break;
			case 'refused':
				settled = entries.map(() => ({ kind: 'refused', path: outcome.path, reason: outcome.reason }));
				break;
			case 'need-base':
				settled = entries.map(() => ({ kind: 'refused', path: outcome.paths[0] ?? '', reason: NO_BASE }));
				break;
		}
		driver.transaction(() => {
			driver.run('UPDATE "epicenter/outbox" SET outcome = ? WHERE n = ?', [JSON.stringify(settled), n]);
			driver.run('DELETE FROM "epicenter/outbox" WHERE outcome IS NOT NULL AND n <= ?', [n - KEEP_SETTLED]);
			driver.run('DELETE FROM "epicenter/commands" WHERE n <= ?', [n - KEEP_SETTLED]);
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
			// wrote; the device shows the server's text again, and a refused move
			// (always alone in its batch) puts its note back.
			for (const { change } of entries)
				if (change.kind === 'move') putBack(change);
				else revert(change.path, n);
		});
		if (outcome.kind !== 'applied') log.warn(EngineDiagnostic.BatchNotApplied({ n, outcome }));
		notify();
		for (const resolve of waiters.get(n) ?? []) resolve(Ok(settled));
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
				'SELECT n, seq, changes FROM "epicenter/outbox" WHERE outcome IS NULL ORDER BY n LIMIT 1',
			);
			if (next === undefined) return;
			const entries = JSON.parse(next.changes) as Entry[];
			const send = (withBases: boolean): Batch => ({
				device,
				n: next.n,
				seq: next.seq,
				changes: entries.map(({ change }): Change =>
					withBases || change.kind === 'move' || change.base === null ? change : { ...change, base: { hash: change.base.hash } },
				),
			});
			// From here the batch may reach the server, so it is never changed again.
			if (next.n > sentThrough()) setMeta('sent', String(next.n));
			let answer = await link.push(send(false));
			if (answer.error === null && answer.data.kind === 'need-base') answer = await link.push(send(true));
			if (answer.error !== null) {
				online = false;
				needsHello = true;
				return;
			}
			if (closed) return;
			conclude(next.n, entries, answer.data);
		}
	}

	kick();

	// ------------------------------------------------------------------------
	// Reads
	// ------------------------------------------------------------------------

	const split = (lens: Lens, params: Params) => buildPath(lens.template, params);

	function listRows(lens: Lens, filter: Params) {
		const keys = Object.entries(filter).filter(([key, value]) => lens.template.params.includes(key) && value !== undefined);
		const where = keys.map(([key]) => `v."${key}" = ?`);
		return driver.all<FileRead>(
			`SELECT f.path, f.text, f.fields, f.body FROM "epicenter/files" f JOIN temp."${lens.name}" v ON v.path = f.path${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY f.path`,
			keys.map(([, value]) => String(value)),
		);
	}

	function getRow(lens: Lens, params: Params): FileRead | null {
		const path = split(lens, params);
		if (path.error !== null) return null;
		return (
			first<FileRead>(driver, 'SELECT path, text, fields, body FROM "epicenter/files" WHERE path = ? AND text IS NOT NULL', [
				path.data,
			]) ?? null
		);
	}

	async function read<TRequest extends EngineRequest>(request: TRequest): Promise<EngineAnswers[TRequest['kind']]> {
		type Answer = EngineAnswers[TRequest['kind']];
		switch (request.kind) {
			case 'get':
				return getRow(lensOf(request.name), request.params) as Answer;
			case 'list':
				return listRows(lensOf(request.name), request.filter) as Answer;
			case 'query':
				return driver.all(request.sql, request.params) as Answer;
			case 'blob': {
				const file = getRow(lensOf(request.name), request.params);
				const pointer = file === null ? null : parsePointer(file.text);
				if (pointer === null) return null as Answer;
				return (request.as === 'bytes' ? await blobs.get(pointer.oid) : await blobs.url(pointer.oid)) as Answer;
			}
			case 'flush':
				await running;
				return undefined as Answer;
		}
	}

	return {
		/** This device's id, as its database records it. */
		device,
		read,
		/** Apply a command's writes here now and send them; see `apply`. */
		submit,
		/** Called with the paths whose shown text changed, after every change. */
		onChange(listener: (paths: string[]) => void) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		close() {
			closed = true;
			link.close();
			listeners.clear();
			for (const resolvers of waiters.values()) for (const resolve of resolvers) resolve(WriteError.Closed());
			waiters.clear();
		},
	};
}
export type Engine = ReturnType<typeof openEngine>;
