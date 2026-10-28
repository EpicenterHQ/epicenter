/**
 * The device engine: one SQLite database per repository per device. It holds
 * every synced file's text and this device's unsent batches, answers reads in
 * SQL, applies writes locally at once, sends batches in order, and rebases
 * unsent edits with the Epicenter merge when the server acknowledges them or
 * reports other devices' changes.
 *
 * Batches share one numbered lane to the server. A person's write is applied
 * and saved here first, resolves then, and is sent with the `'mark'` policy;
 * what the server later does with it that the person should know becomes a
 * row in `"epicenter/notices"`, which never syncs. A `send` is sent with
 * `'refuse'`, changes nothing here until its verdict, and folds an applied
 * verdict into the files, since the server never echoes a batch to its
 * sender.
 *
 * Everything it takes and returns is plain data (`EngineRequest`, `WriteOp`),
 * so it runs in the caller's thread (`openRepository`) or in the worker of
 * the one browser tab that owns the repository; `createRepository` turns it
 * into the app API.
 */
import { createLogger, type Logger } from 'wellcrafted/logger';
import { defineErrors } from 'wellcrafted/error';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';
import type { App, Definitions, Lens, Notice, SendOptions, Verdict } from '../define.js';
import { SendError, WriteError } from '../define.js';
import { gitBlobHash, sha256 } from '../hash.js';
import { BODY_SQL, parseMarkdown, parsePointer, splitMarkdown, storageRefusal, writeMarkdown, writePointer } from '../markdown.js';
import { merge } from '../merge.js';
import { describe } from '../policy.js';
import type { Policy } from '../policy.js';
import type { Batch, BatchOutcome, Broadcast, Change, ChangeOutcome, FileState, Move } from '../protocol.js';
import { first, type SqlDriver, type SqlValue } from '../sql.js';
import { buildPath, isFilePath } from '../templates.js';
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
	seq INTEGER NOT NULL DEFAULT 0,
	held INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE TABLE IF NOT EXISTS "epicenter/outbox" (
	n INTEGER PRIMARY KEY,
	seq INTEGER NOT NULL,
	policy TEXT NOT NULL,
	changes TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS "epicenter/notices" (
	id INTEGER PRIMARY KEY,
	at INTEGER NOT NULL,
	kind TEXT NOT NULL,
	path TEXT NOT NULL,
	reason TEXT NOT NULL,
	kept TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS "epicenter/meta" (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
`;

const PARSER_VERSION = '1';

/** Why a change the server still lacks a base for, after it was resent with its bases, did not land. */
const NO_BASE = 'the server has no base for this change';

const EngineDiagnostic = defineErrors({
	SyncStepFailed: ({ cause }: { cause: unknown }) => ({
		message: 'A sync step failed; it will run again on the next change or reconnect',
		cause,
	}),
	/** A person's batch the server could not apply, which is a bug; its changes became notices. */
	BatchNotApplied: ({ n, outcome }: { n: number; outcome: BatchOutcome }) => ({
		message: `Batch ${n} was not applied (${outcome.kind}); its changes were reverted and kept in notices`,
		n,
		outcome,
	}),
});

/**
 * One change as kept in the outbox: what was sent, and the text it leaves
 * at its path (a move's destination) once it lands as made. A person's
 * write starts from the last of these for its path, the queued projection;
 * a `send`'s shows here only after an applied verdict.
 */
type Entry = { change: Change; local: string | null };

/**
 * A file on this device: the text it shows, the server's text and hash as
 * this device last heard them, and `held`, 1 while `text` holds text this
 * device keeps to itself beyond its queued changes, which no outbox row
 * carries, so every reconciliation keeps it.
 */
type FileRow = { path: string; text: string | null; synced: string | null; hash: string | null; seq: number; held: number };

/**
 * A file as reads return it: its text, the parsed fields as JSON (null when
 * they do not parse), the body, and `version`, the hash of the text.
 */
export type FileRead = { path: string; text: string; fields: string | null; body: string; version: string };

/** The columns a read selects; `version` is the server's hash where the text is the server's, else null until `withVersion` hashes it. */
const READ_COLUMNS = (f: string) => `${f}.path, ${f}.text, ${f}.fields, ${f}.body, CASE WHEN ${f}.text IS ${f}.synced THEN ${f}.hash END AS version`;

/** A read row with its version: the stored hash when the text is the server's, otherwise the text's own hash. */
type ReadRow = Omit<FileRead, 'version'> & { version: string | null };
const withVersion = (file: ReadRow): FileRead => ({
	...file,
	version: file.version ?? gitBlobHash(file.text),
});

type Params = Record<string, unknown>;

/**
 * One write an app asks for, as data, so it can cross to a worker. `base` is
 * what a `send` change starts from (the note as the caller read it, or
 * `'latest'`); a person's write has none, since it starts from what the
 * server will have once this device's queued writes land.
 */
export type WriteOp =
	| { kind: 'create'; name: string; params: Params; input: { fields?: Record<string, unknown>; body?: string } }
	| { kind: 'write'; name: string; params: Params; input: { fields?: Record<string, unknown>; body?: string }; base?: SendBase }
	| { kind: 'set'; name: string; params: Params; key: string; value: unknown; base?: SendBase }
	/** The body edited from `from`, the body the editor last showed, to `body`. */
	| { kind: 'edit'; name: string; params: Params; from: string; body: string }
	| { kind: 'append'; name: string; params: Params; text: string; base?: SendBase }
	| { kind: 'move'; name: string; from: Params; to: Params }
	| { kind: 'delete'; name: string; params: Params; base?: SendBase }
	| { kind: 'put'; name: string; params: Params; bytes: Uint8Array; type: string; base?: SendBase }
	/**
	 * A Markdown file's whole text replaced, frontmatter included, at any
	 * path, whether or not a template names it. With `from`, the text the
	 * editor last showed, a change that reached this device meanwhile is
	 * kept: the text is merged onto it, and this text wins an overlap.
	 */
	| { kind: 'text'; path: string; text: string; from?: string | null };

/** What a `send` change to an existing path starts from. */
type SendBase = SendOptions['from'];

/** A read, as data. */
export type EngineRequest =
	| { kind: 'get'; name: string; params: Params }
	/** Any synced file by its path, whether or not a template names it. */
	| { kind: 'file'; path: string }
	| { kind: 'list'; name: string; filter: Params }
	| { kind: 'query'; sql: string; params: SqlValue[] }
	| { kind: 'blob'; name: string; params: Params; as: 'bytes' | 'url' }
	/** Resolves when queued sync work has run: the outbox is sent, or the server is unreachable. */
	| { kind: 'flush' };

/** What each read answers. */
export type EngineAnswers = {
	get: FileRead | null;
	file: FileRead | null;
	list: FileRead[];
	query: Record<string, SqlValue>[];
	blob: Uint8Array | string | null;
	flush: undefined;
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

/**
 * Bring a database an earlier build made up to this schema, keeping its
 * data: its files had no `held` column, its outbox kept settled rows with
 * their outcome for retried command ids, and had no policy, since every
 * batch it sent was a person's.
 */
function upgrade(driver: SqlDriver) {
	const columnsOf = (table: string) => new Set(driver.all<{ name: string }>('SELECT name FROM pragma_table_info(?)', [table]).map((c) => c.name));
	const columns = columnsOf('epicenter/outbox');
	const fileColumns = columnsOf('epicenter/files');
	driver.transaction(() => {
		if (!fileColumns.has('held')) driver.exec('ALTER TABLE "epicenter/files" ADD COLUMN held INTEGER NOT NULL DEFAULT 0');
		if (!columns.has('policy')) driver.exec(`ALTER TABLE "epicenter/outbox" ADD COLUMN policy TEXT NOT NULL DEFAULT 'mark'`);
		if (columns.has('outcome')) {
			driver.exec('DELETE FROM "epicenter/outbox" WHERE outcome IS NOT NULL');
			driver.exec('ALTER TABLE "epicenter/outbox" DROP COLUMN outcome');
		}
		driver.exec('DROP TABLE IF EXISTS "epicenter/commands"');
	});
}

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
	upgrade(driver);

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
		first<FileRow>(driver, 'SELECT path, text, synced, hash, seq, held FROM "epicenter/files" WHERE path = ?', [path]);

	/** Paths whose shown text changed since the last notification. */
	const changed = new Set<string>();

	/**
	 * The one write path: text and its parsed fields in the same statement.
	 * `held` stays what it was unless `next` says.
	 */
	function put(path: string, { held: nextHeld, ...next }: Omit<FileRow, 'path' | 'held'> & { held?: number }) {
		const previous = row(path);
		const held = nextHeld ?? previous?.held ?? 0;
		if ((previous?.text ?? null) !== next.text) changed.add(path);
		if (next.text === null && next.synced === null) {
			driver.run('DELETE FROM "epicenter/files" WHERE path = ?', [path]);
			return;
		}
		if (computedFields)
			driver.run('INSERT OR REPLACE INTO "epicenter/files" (path, text, synced, hash, seq, held) VALUES (?, ?, ?, ?, ?, ?)', [
				path,
				next.text,
				next.synced,
				next.hash,
				next.seq,
				held,
			]);
		else
			driver.run(
				'INSERT OR REPLACE INTO "epicenter/files" (path, text, fields, synced, hash, seq, held) VALUES (?, ?, ?, ?, ?, ?, ?)',
				[path, next.text, fieldsOf(next.text), next.synced, next.hash, next.seq, held],
			);
	}
	const keep = (path: string): FileRow => row(path) ?? { path, text: null, synced: null, hash: null, seq: 0, held: 0 };

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
		if (changed.size === 0 && !noticed) return;
		const paths = [...changed];
		changed.clear();
		noticed = false;
		for (const listener of listeners) listener(paths);
	}

	// ------------------------------------------------------------------------
	// Server changes
	// ------------------------------------------------------------------------

	/** A file a move made elsewhere took along: this device's text of it, what that text was based on, and whether it was held. */
	type Carried = { base: string | null; local: string | null; held: number };

	function serverFile(file: FileState, seq: number, carried?: Carried) {
		if (!isDeviceFile(file.path, file.text)) return;
		const current = keep(file.path);
		if (current.seq > seq) return;
		const base = carried?.base ?? current.synced;
		const local = carried?.local ?? current.text;
		// A note this device moved here, unacknowledged, is not what the server
		// put here: the server keeps its own, and the move is put back.
		const movedByThisDevice = carried === undefined && current.text !== null && current.synced === null && movedHere(file.path);
		const text = movedByThisDevice ? local : rebaseLocal(base, local, file.text);
		put(file.path, { text, synced: file.text, hash: file.hash, seq, held: carried?.held });
	}

	function receive(broadcast: Broadcast) {
		driver.transaction(() => {
			const carried = new Map<string, Carried>();
			for (const move of broadcast.moves) carryMove(move, carried);
			for (const file of broadcast.files) serverFile(file, broadcast.seq, carried.get(file.path));
			advance(broadcast.seq);
		});
		notify();
	}

	/** A move made elsewhere takes this device's unsent edits of the file along. */
	function carryMove({ from, to }: Move, carried: Map<string, Carried>) {
		const source = row(from);
		if (source === undefined || source.text === source.synced) return;
		carried.set(to, { base: source.synced, local: source.text, held: source.held });
		put(from, { ...source, text: null, synced: null, hash: null, held: 0 });
	}

	// ------------------------------------------------------------------------
	// Local changes and the outbox
	// ------------------------------------------------------------------------

	type Local = { kind: 'write'; path: string; text: string | null } | { kind: 'move'; from: string; to: string } | { kind: 'append'; path: string; text: string };

	/**
	 * Apply one change on this device and say what to send. Runs inside the
	 * batch's transaction. The change starts from the queued projection,
	 * what the server will have once this device's queued writes land, never
	 * from the text shown here, which can hold changes merged in from
	 * elsewhere or text this device keeps to itself.
	 */
	function applyLocal(change: Local): Entry {
		const baseOf = (text: string) => ({ hash: gitBlobHash(text), text });
		if (change.kind === 'move') {
			const source = keep(change.from);
			const destination = keep(change.to);
			const moved = projection(change.from);
			put(change.from, { ...source, text: null });
			put(change.to, { ...destination, text: source.text });
			return { change, local: moved };
		}
		const current = keep(change.path);
		const from = projection(change.path);
		if (change.kind === 'append') {
			put(change.path, { ...current, text: (current.text ?? '') + change.text });
			return { change: { ...change, base: baseOf(from ?? '') }, local: (from ?? '') + change.text };
		}
		put(change.path, { ...current, text: change.text });
		return { change: { kind: 'write', path: change.path, base: from === null ? null : baseOf(from), text: change.text }, local: change.text };
	}

	/** A person's queued entries, oldest first. */
	const queuedEntries = () => unsent().flatMap((batch) => JSON.parse(batch.changes) as Entry[]);

	/**
	 * What the server will have at `path` once every queued change of a
	 * person lands as made: what the last queued change touching it leaves
	 * (nothing at a move's source), or the server's text.
	 */
	function projection(path: string): string | null {
		const last = queuedEntries().findLast((entry) => pathsOf(entry).includes(path));
		if (last === undefined) return row(path)?.synced ?? null;
		return last.change.kind === 'move' && last.change.from === path ? null : last.local;
	}

	/** Whether this device moved a note to `path` and the move is still queued: the last change touching `path` is that move. */
	function movedHere(path: string): boolean {
		const last = queuedEntries().findLast((entry) => pathsOf(entry).includes(path));
		return last?.change.kind === 'move' && last.change.to === path;
	}

	/** Every op but a blob put, whose bytes are stored first and which then writes its pointer's text. */
	type Ready = Exclude<WriteOp, { kind: 'put' }> | { kind: 'pointer'; name: string; params: Params; text: string; base?: SendBase };

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

	/**
	 * The checks a push is refused for, run before a write resolves, so a
	 * person learns at once instead of in a notice later. `previous` is the
	 * text the write replaces: a note that parses never stops parsing.
	 */
	function storable(path: string, previous: string | null, text: string | null): Result<undefined, WriteError> {
		const refusal = text === null ? null : storageRefusal(path, previous, text);
		if (refusal === null) return Ok(undefined);
		if (refusal.kind === 'parse') return WriteError.Unparseable({ path, reason: refusal.reason });
		return WriteError.NotStorable({ path, reason: refusal.reason });
	}

	/** What one op does on this device, read against what the device shows now, if it can be stored. */
	function resolve(op: Ready): Result<Local, WriteError> {
		const local = resolveOp(op);
		if (local.error !== null || local.data.kind === 'move') return local;
		const { path } = local.data;
		const previous = localText(path);
		const text = local.data.kind === 'append' ? (previous ?? '') + local.data.text : local.data.text;
		const checked = storable(path, previous, text);
		return checked.error !== null ? checked : local;
	}

	/** The path a text op names, if a synced Markdown file can be there. */
	function textPath(path: string): Result<string, WriteError> {
		if (!isFilePath(path)) return WriteError.InvalidPath({ path, reason: 'it has an empty, hidden, relative or unusable segment' });
		if (!path.endsWith('.md')) return WriteError.InvalidPath({ path, reason: 'only a Markdown file is written as text' });
		return Ok(path);
	}

	function resolveOp(op: Ready): Result<Local, WriteError> {
		if (op.kind === 'text') {
			const path = textPath(op.path);
			if (path.error !== null) return path;
			const current = localText(path.data);
			// As for an editor's edit: what changed here since it last showed the text stays.
			const text = op.from === undefined || current === op.from ? op.text : (merge(op.from, op.text, current).text ?? op.text);
			return Ok({ kind: 'write', path: path.data, text });
		}
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
			case 'edit': {
				// What changed here since the editor last showed the body stays: the
				// edit is merged onto it, and the person's text wins an overlap.
				const shown = current === null ? '' : current.slice(splitMarkdown(current).bodyStart);
				const body = shown === op.from ? op.body : (merge(op.from, op.body, shown).text ?? op.body);
				const text = writeMarkdown(current, { body });
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
		return Ok({ kind: 'pointer', name: op.name, params: op.params, text: writePointer({ oid, size: op.bytes.length }), base: op.base });
	}

	/** The highest batch number ever handed to the transport: a batch at or below it may have reached the server. */
	const sentThrough = () => Number(meta('sent') ?? '0');

	/**
	 * The last outbox row, when a write to `path` can take its place: the row
	 * is unsent and was never handed to the transport, and it holds exactly
	 * one write to `path` that leaves text. A delete keeps its own row, so a
	 * delete and a recreate never become one edit.
	 */
	function coalescible(path: string): { n: number; entry: Entry } | undefined {
		const last = first<{ n: number; policy: Policy; changes: string }>(
			driver,
			'SELECT n, policy, changes FROM "epicenter/outbox" ORDER BY n DESC LIMIT 1',
		);
		if (last === undefined || last.policy !== 'mark' || last.n <= sentThrough()) return undefined;
		const entries = JSON.parse(last.changes) as Entry[];
		const [entry] = entries;
		if (entries.length !== 1 || entry === undefined) return undefined;
		const { change } = entry;
		if (change.kind !== 'write' || change.path !== path || change.text === null) return undefined;
		return { n: last.n, entry };
	}

	/**
	 * Queue a command's batches and answer their numbers. A command that is
	 * one write leaving text, to the path the last unsent write names,
	 * replaces that write's text instead of adding a row; the base stays the
	 * text the first write started from. Typing then sends one batch per send
	 * rather than one per keystroke.
	 */
	function queue(batches: Entry[][]): number[] {
		const only = batches.length === 1 && batches[0]?.length === 1 ? batches[0][0] : undefined;
		const into = only?.change.kind === 'write' && only.change.text !== null ? coalescible(only.change.path) : undefined;
		if (only !== undefined && into !== undefined && into.entry.change.kind === 'write') {
			const replaced: Entry = { change: { ...into.entry.change, text: only.local }, local: only.local };
			driver.run('UPDATE "epicenter/outbox" SET changes = ? WHERE n = ?', [JSON.stringify([replaced]), into.n]);
			return [into.n];
		}
		return batches.map((entries) => enqueue('mark', entries));
	}

	/** Add one batch to the end of the lane under the next number. */
	function enqueue(policy: Policy, entries: Entry[]): number {
		const n = Number(meta('next') ?? '1');
		setMeta('next', String(n + 1));
		driver.run('INSERT INTO "epicenter/outbox" (n, seq, policy, changes) VALUES (?, ?, ?, ?)', [n, position(), policy, JSON.stringify(entries)]);
		return n;
	}

	/**
	 * Apply ops locally and queue them, in one transaction. A move is sent as
	 * a batch of its own, so a move the server leaves undone, or a fault in
	 * one, touches nothing around it.
	 */
	function apply(ops: Ready[]): Result<undefined, WriteError> {
		if (closed) return WriteError.Closed();
		let failure: WriteError | null = null;
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
				queue(batches);
			});
		} catch (cause) {
			if (cause !== ROLLBACK) throw cause;
			changed.clear();
		}
		if (failure !== null) return Err(failure);
		notify();
		kick();
		return Ok(undefined);
	}

	/** Store each blob's bytes and turn its put into a pointer write. */
	async function uploadAll(ops: WriteOp[]): Promise<Result<Ready[], WriteError>> {
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
	}

	/** The paths ops name; ops whose parameters build no path name none, and fail when they run. */
	function opPaths(ops: (WriteOp | Ready)[]): string[] {
		return ops.flatMap((op) => {
			if (op.kind === 'text') {
				const path = textPath(op.path);
				return path.error === null ? [path.data] : [];
			}
			const lens = lensOf(op.name);
			const named = op.kind === 'move' ? [op.from, op.to] : [op.params];
			return named.flatMap((params) => {
				const path = pathOf(lens, params);
				return path.error === null ? [path.data] : [];
			});
		});
	}

	/**
	 * Sends waiting for their verdict, by the paths they touch. A person's
	 * write to one of those paths waits for the verdict before it applies, so
	 * it starts from the send's result instead of racing it at the server.
	 */
	const inFlight = new Map<string, Promise<void>>();
	const blockersOf = (paths: string[]) => paths.flatMap((path) => inFlight.get(path) ?? []);

	/**
	 * Apply a person's writes here, save them and queue them; resolves once
	 * they are saved, never waiting for the server. Blob bytes are stored
	 * first, and writes to a path a `send` is waiting on wait for its verdict.
	 */
	function submit(ops: WriteOp[]): Promise<Result<undefined, WriteError>> {
		const blockers = blockersOf(opPaths(ops));
		if (blockers.length === 0 && !ops.some((op) => op.kind === 'put')) return Promise.resolve(apply(ops as Ready[]));
		return (async () => {
			await Promise.all(blockers);
			const ready = await uploadAll(ops);
			return ready.error !== null ? ready : apply(ready.data);
		})();
	}

	// ------------------------------------------------------------------------
	// Send: one batch that waits for the server's verdict
	// ------------------------------------------------------------------------

	type SendResult = Result<Verdict, WriteError | SendError>;
	const verdicts = new Map<number, (result: SendResult) => void>();

	/**
	 * What one `send` op sends, read against what it names it starts from:
	 * the note as the caller read it, whose text goes along, or `'latest'`,
	 * the server's text as this device last heard it. Nothing on the device
	 * changes.
	 */
	function resolveSend(op: Ready): Result<Entry, WriteError | SendError> {
		const based = (path: string): Result<{ hash: string; text: string } | null, WriteError> => {
			const requested = 'base' in op ? op.base : undefined;
			if (op.kind === 'create') {
				const file = keep(path);
				return file.synced !== null || file.text !== null ? WriteError.Exists({ path }) : Ok(null);
			}
			// The handle types require it; a caller that bypasses them made a mistake in its source.
			if (requested === undefined) throw new Error(`A send's change to '${path}' names what it starts from: { from: note } or { from: 'latest' }`);
			if (requested !== 'latest') return Ok({ hash: requested.version, text: requested.text });
			const file = keep(path);
			return Ok(file.synced === null || file.hash === null ? null : { hash: file.hash, text: file.synced });
		};
		if (op.kind === 'move') {
			const lens = lensOf(op.name);
			const from = pathOf(lens, op.from);
			if (from.error !== null) return from;
			const to = pathOf(lens, op.to);
			if (to.error !== null) return to;
			const source = keep(from.data);
			if (source.synced === null) return WriteError.NotFound({ path: from.data });
			if (keep(to.data).synced !== null) return WriteError.Exists({ path: to.data });
			return Ok({ change: { kind: 'move', from: from.data, to: to.data }, local: source.synced });
		}
		const path = op.kind === 'text' ? textPath(op.path) : pathOf(lensOf(op.name), op.params);
		if (path.error !== null) return path;
		const base = based(path.data);
		if (base.error !== null) return base;
		const from = base.data?.text ?? null;
		const write = (text: string | null): Result<Entry, WriteError> => {
			const checked = storable(path.data, from, text);
			return checked.error !== null ? checked : Ok({ change: { kind: 'write', path: path.data, base: base.data, text }, local: text });
		};
		switch (op.kind) {
			case 'text':
			case 'pointer':
				return write(op.text);
			case 'delete':
				if (from === null) return WriteError.NotFound({ path: path.data });
				return write(null);
			case 'append':
				if (base.data === null) return WriteError.NotFound({ path: path.data });
				const appended = storable(path.data, base.data.text, base.data.text + op.text);
				if (appended.error !== null) return appended;
				return Ok({ change: { kind: 'append', path: path.data, text: op.text, base: base.data }, local: base.data.text + op.text });
			case 'create':
			case 'write':
			case 'set':
			case 'edit': {
				const change = op.kind === 'set' ? { fields: { [op.key]: op.value } } : op.kind === 'edit' ? { body: op.body } : op.input;
				const text = writeMarkdown(from, change);
				if (text.error !== null) return WriteError.Unparseable({ path: path.data, reason: text.error.reason });
				return write(text.data);
			}
		}
	}

	/** Whether a batch still in the lane touches any of `paths`. */
	const laneTouches = (paths: string[]) =>
		driver
			.all<{ changes: string }>('SELECT changes FROM "epicenter/outbox"')
			.some((batch) => (JSON.parse(batch.changes) as Entry[]).some((entry) => pathsOf(entry).some((path) => paths.includes(path))));

	/**
	 * Send ops as one batch with the `'refuse'` policy and wait for the
	 * server's verdict. Offline, it fails at once and queues nothing. Its
	 * paths are claimed at once, so a person's write to them made from now on
	 * waits for the verdict. It waits for earlier sends and batches touching
	 * its paths to be answered, so it starts from what the server
	 * acknowledged, then queues one durable, numbered row, and changes
	 * nothing here until the verdict.
	 */
	function send(ops: WriteOp[]): Promise<SendResult> {
		if (closed) return Promise.resolve(WriteError.Closed());
		if (!online || !link.connected()) return Promise.resolve(SendError.Offline());
		const paths = opPaths(ops);
		const earlier = blockersOf(paths);
		const result = sendAfter(earlier, ops, paths);
		const claim = result.then(() => undefined);
		for (const path of paths) inFlight.set(path, claim);
		void claim.then(() => {
			for (const path of paths) if (inFlight.get(path) === claim) inFlight.delete(path);
		});
		return result;
	}

	async function sendAfter(earlier: Promise<void>[], ops: WriteOp[], paths: string[]): Promise<SendResult> {
		await Promise.all(earlier);
		const ready = await uploadAll(ops);
		if (ready.error !== null) return ready;
		const head = () => first<{ n: number }>(driver, 'SELECT n FROM "epicenter/outbox" ORDER BY n LIMIT 1')?.n;
		while (!closed && online && laneTouches(paths)) {
			const before = head();
			await kick();
			// A lane that made no progress is a sync step failing over and over.
			if (online && head() === before) return SendError.Offline();
		}
		if (closed) return WriteError.Closed();
		if (!online || !link.connected()) return SendError.Offline();
		const entries: Entry[] = [];
		for (const op of ready.data) {
			const entry = resolveSend(op);
			if (entry.error !== null) return entry;
			entries.push(entry.data);
		}
		const n = driver.transaction(() => enqueue('refuse', entries));
		const verdict = new Promise<SendResult>((resolve) => verdicts.set(n, resolve));
		kick();
		return verdict;
	}

	/** Answer a `send` waiting on batch `n`, if one is, and say whether one was. */
	function answerSend(n: number, result: SendResult) {
		const resolve = verdicts.get(n);
		verdicts.delete(n);
		resolve?.(result);
		return resolve !== undefined;
	}
	/** Tell a `send` waiting on batch `n` that its verdict is not known here; the row stays. */
	const verdictUnknown = (n: number) => answerSend(n, SendError.Unknown({ n }));

	/**
	 * Write an applied `send`'s result into the files, as a broadcast of it
	 * would: the server sends its sender no broadcast.
	 */
	function fold(entries: Entry[], outcome: Extract<BatchOutcome, { kind: 'applied' }>, seq: number) {
		for (const [index, { change }] of entries.entries()) {
			const result = outcome.changes[index];
			if (result === undefined) continue;
			const text = result.text !== undefined ? result.text : change.kind === 'write' ? change.text : null;
			const named = change.kind === 'move' ? change.from : change.path;
			const left = result.movedTo ?? named;
			if (change.kind === 'move' || result.at !== left) serverFile({ path: left, text: null, hash: null }, seq);
			if (result.at !== null) serverFile({ path: result.at, text, hash: result.hash }, seq);
		}
	}

	/** The paths an outbox entry touches. */
	const pathsOf = ({ change }: Entry) => (change.kind === 'move' ? [change.from, change.to] : [change.path]);

	/** A person's batches still in the lane; a `send` shows nothing here, so it covers no path. */
	const unsent = (except = -1) =>
		driver.all<{ n: number; changes: string }>(
			`SELECT n, changes FROM "epicenter/outbox" WHERE policy = 'mark' AND n <> ? ORDER BY n`,
			[except],
		);

	/** Whether a queued batch other than `except` touches `path`. */
	const isPending = (path: string, except: number) =>
		unsent(except).some((p) => (JSON.parse(p.changes) as Entry[]).some((e) => pathsOf(e).includes(path)));

	/**
	 * Whether this device shows text of its own at `path` beyond what batch
	 * `n` sent: a later queued change, or text it holds. Otherwise what it
	 * shows beyond `sent` is only what reached it from elsewhere, and the
	 * server's answer already holds that.
	 */
	const keepsOwn = (path: string, n: number) => keep(path).held === 1 || isPending(path, n);

	/**
	 * Show the server's text again where batch `n`'s change did not land,
	 * keeping this device's own text beyond `sent`, what the change left
	 * here, rebased onto the server's.
	 */
	function revert(path: string, sent: string | null, n: number) {
		const current = keep(path);
		put(path, { ...current, text: keepsOwn(path, n) ? rebaseLocal(sent, current.text, current.synced) : current.synced });
	}

	/** What an entry left at `path` when it was made: nothing at a move's source. */
	const leftAt = ({ change, local }: Entry, path: string) => (change.kind === 'move' && change.from === path ? null : local);

	/**
	 * A move that did not land puts its note back at `from`, and later unsent
	 * changes aimed at `to` are aimed at `from` again, so they reach the note
	 * and never what holds `to`. `server` is the note's text at `from` when
	 * the server reported it, and `base` the text the move carried: edits
	 * made here since are rebased onto it. When a later change also names
	 * `from`, only the server's texts are shown again.
	 */
	function putBack(
		{ from, to }: { from: string; to: string },
		sent: string | null,
		server?: { text: string | null; hash: string | null; seq: number },
	) {
		if (server !== undefined) put(from, { ...keep(from), synced: server.text, hash: server.hash, seq: server.seq });
		const entries = unsent().map((batch) => ({ n: batch.n, entries: JSON.parse(batch.changes) as Entry[] }));
		if (entries.some((batch) => batch.entries.some((entry) => pathsOf(entry).includes(from)))) {
			revert(from, null, -1);
			revert(to, sent, -1);
			return;
		}
		const moved = keep(to);
		const here = keep(from);
		// The note's own text goes back with it, rebased onto the server's
		// text at `from`: what the last queued change to it left, or what the
		// move carried, or the text this device holds for it.
		const later = entries.flatMap((batch) => batch.entries).findLast((entry) => pathsOf(entry).includes(to));
		const own = moved.held === 1 ? moved.text : (later?.local ?? sent);
		put(from, { ...here, text: rebaseLocal(sent, own, here.synced), held: moved.held });
		put(to, { ...moved, text: moved.synced, held: 0 });
		const aimed = (path: string) => (path === to ? from : path);
		for (const batch of entries) {
			const retargeted = batch.entries.map(({ change, local }): Entry => ({
				local,
				change: change.kind === 'move' ? { ...change, from: aimed(change.from) } : { ...change, path: aimed(change.path) },
			}));
			driver.run('UPDATE "epicenter/outbox" SET changes = ? WHERE n = ?', [JSON.stringify(retargeted), batch.n]);
		}
	}

	/** A move the server did not apply, since the note was renamed since or its destination is another note's. */
	const keptInPlace = (outcome: ChangeOutcome) =>
		outcome.overlaps.some(
			(overlap) => (overlap.unit === 'field' && overlap.key === 'path') || (overlap.unit === 'path' && overlap.clash === 'taken'),
		);

	/**
	 * Fold the server's answer for one sent change into this device's files.
	 * With no later unsent change to the path, the server's text is the answer;
	 * otherwise the later edits are rebased onto it.
	 */
	function acknowledge(n: number, entry: Entry, outcome: ChangeOutcome, seq: number) {
		const { change, local: sent } = entry;
		// This device's own text beyond what it sent stays, rebased onto the server's answer.
		const rebase = (path: string, local: string | null, server: string | null) =>
			keepsOwn(path, n) ? rebaseLocal(sent, local, server) : server;
		const serverText = outcome.text !== undefined ? outcome.text : change.kind === 'write' ? change.text : null;
		if (change.kind === 'move' && keptInPlace(outcome)) {
			// The current path won: the note stays where the server has it.
			putBack({ from: outcome.at ?? change.from, to: change.to }, sent, { text: serverText, hash: outcome.hash, seq });
			return;
		}
		const clash = outcome.overlaps.find((overlap) => overlap.unit === 'path');
		if (clash !== undefined) {
			// The change did not land where it was aimed, which may now hold a
			// different note: show the server's text there again, and the change
			// in the sibling the server made for it.
			for (const path of pathsOf(entry)) revert(path, leftAt(entry, path), n);
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
			put(change.path, { text: rebase(change.path, current.text, null), synced: null, hash: null, seq });
			return;
		}
		const current = keep(change.path);
		if (outcome.movedTo !== null) {
			// The edit followed its note to `at`, by a move made elsewhere or to a
			// sibling the server made for it, and this device's text of the note
			// goes with it: from the path the edit named, or from `at` when a move
			// elsewhere already carried it there. The path it named shows the
			// server's text again: nothing after a move, a different note after a
			// reuse. Later changes aimed at it still show there until answered.
			const source = current.text === null && current.synced === null ? keep(outcome.at) : current;
			const own = keepsOwn(source.path, n) ? rebaseLocal(sent, source.text, serverText) : serverText;
			if (!isPending(change.path, n)) put(change.path, { ...current, text: current.synced, held: 0 });
			put(outcome.at, { text: own, synced: serverText, hash: outcome.hash, seq, held: source.held });
			return;
		}
		put(change.path, { text: rebase(change.path, current.text, serverText), synced: serverText, hash: outcome.hash, seq });
	}

	/**
	 * Settle a `send`'s batch: an applied verdict is written into the files,
	 * a refusal changes nothing, and the caller, if still waiting, is told.
	 */
	function concludeSend(n: number, entries: Entry[], outcome: BatchOutcome) {
		driver.transaction(() => {
			driver.run('DELETE FROM "epicenter/outbox" WHERE n = ?', [n]);
			if (outcome.kind !== 'applied' || outcome.seq === null) return;
			fold(entries, outcome, outcome.seq);
			advance(outcome.seq);
		});
		const verdict: Verdict =
			outcome.kind === 'applied'
				? { kind: 'applied', seq: outcome.seq, changes: outcome.changes }
				: outcome.kind === 'refused'
					? { kind: 'refused', path: outcome.path, reason: outcome.reason, overlaps: outcome.overlaps }
					: { kind: 'refused', path: outcome.paths[0] ?? '', reason: NO_BASE, overlaps: [] };
		// A refusal nobody is waiting for any more, after a lost reply or a closed tab, is kept as a notice.
		if (!answerSend(n, Ok(verdict)) && verdict.kind === 'refused') {
			const sent = entries.find(({ change }) => (change.kind === 'move' ? change.from : change.path) === verdict.path);
			notice('refused', verdict.path, verdict.reason, sent?.local ?? null);
		}
		notify();
	}

	/** Settle a person's batch: fold its outcome into this device's files, note what they should know, and drop its row. */
	function conclude(n: number, entries: Entry[], outcome: BatchOutcome) {
		driver.transaction(() => {
			driver.run('DELETE FROM "epicenter/outbox" WHERE n = ?', [n]);
			switch (outcome.kind) {
				case 'applied':
					// With no seq the batch landed long ago, and the hello that came
					// first already brought what it did.
					if (outcome.seq === null) return;
					for (const [index, entry] of entries.entries()) {
						const change = outcome.changes[index];
						if (change === undefined) continue;
						acknowledge(n, entry, change, outcome.seq);
						noteLanding(entry, change);
					}
					advance(outcome.seq);
					return;
				// The server never refuses a person's batch but for a fault.
				case 'refused':
					fault(entries, outcome.reason);
					return;
				case 'need-base':
					fault(entries, NO_BASE);
					return;
			}
		});
		if (outcome.kind !== 'applied') log.warn(EngineDiagnostic.BatchNotApplied({ n, outcome }));
		notify();
	}

	/** A path's last segment without `.md`: the name a person knows a note by. */
	const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, '');

	/** A field value as a person reads it in a notice: a string quoted, anything else as JSON. */
	const valueOf = (value: unknown) => (typeof value === 'string' ? `'${value}'` : JSON.stringify(value));

	/**
	 * A person's change that did not land as made: a value it set that the
	 * current one kept out, or a change that landed somewhere other than where
	 * it was aimed, or nowhere. Every value a person set that did not land
	 * shows in a notice.
	 */
	function noteLanding({ change, local }: Entry, result: ChangeOutcome) {
		const aimed = change.kind === 'move' ? change.from : change.path;
		if (change.kind === 'move' && keptInPlace(result)) {
			const at = result.at ?? change.from;
			const renamed = at !== change.from;
			notice(
				'refused',
				at,
				renamed
					? `renamed to '${nameOf(at)}' elsewhere; your rename to '${nameOf(change.to)}' wasn't applied`
					: `'${nameOf(change.to)}' is taken; your note is still '${nameOf(at)}'`,
			);
			return;
		}
		for (const overlap of result.overlaps) {
			if (overlap.unit === 'field' && overlap.settled === 'current-kept') {
				notice(
					'refused',
					result.at ?? aimed,
					`'${overlap.key}' was changed to ${valueOf(overlap.current)} elsewhere; your ${valueOf(overlap.incoming)} wasn't applied`,
				);
				continue;
			}
			if (overlap.unit === 'file' && overlap.clash === 'unparseable') {
				notice('refused', result.at ?? aimed, "merged with a change made elsewhere, its frontmatter would no longer parse, so your change wasn't applied", local);
				continue;
			}
			if (overlap.unit !== 'path') continue;
			if (overlap.settled === 'relocated' && overlap.relocatedTo !== null)
				notice('relocated', overlap.relocatedTo, `${describe(overlap)}, so this change to ${aimed} was saved here`);
			else if (overlap.settled === 'dropped') notice('dropped', aimed, describe(overlap));
		}
	}

	/**
	 * A person's batch the server could not apply. Nothing that only depends
	 * on the change itself gets here, since those checks run before a write
	 * resolves, so this is a bug. The device shows the server's text again,
	 * and each notice keeps what it showed, so nothing typed is lost.
	 */
	function fault(entries: Entry[], reason: string) {
		for (const { change, local } of entries) {
			if (change.kind === 'move') {
				putBack(change, local);
				notice('protocol', change.from, reason);
				continue;
			}
			const shown = keep(change.path).text;
			revert(change.path, local, -1);
			const after = keep(change.path).text;
			notice('protocol', change.path, reason, after === shown ? null : shown);
		}
	}

	// ------------------------------------------------------------------------
	// Notices: what a person should know about a change after it was saved
	// ------------------------------------------------------------------------

	/** Whether the notices changed since the last notification. */
	let noticed = false;
	function notice(kind: Notice['kind'], path: string, reason: string, kept: string | null = null) {
		driver.run('INSERT INTO "epicenter/notices" (at, kind, path, reason, kept) VALUES (?, ?, ?, ?, ?)', [Date.now(), kind, path, reason, kept]);
		noticed = true;
	}

	/** The person has seen a notice. */
	function dismiss(id: number) {
		driver.run('DELETE FROM "epicenter/notices" WHERE id = ?', [id]);
		noticed = true;
		notify();
	}

	// ------------------------------------------------------------------------
	// Sync: hello, then send the outbox in order, one batch in flight
	// ------------------------------------------------------------------------

	let closed = false;
	let online = true;
	/**
	 * Bumped each time the link comes back, so a call that failed on an
	 * older connection does not take the device offline after it returned.
	 */
	let connection = 0;
	let needsHello = true;
	let running: Promise<void> = Promise.resolve();
	const link = transport.connect({
		device,
		onBroadcast: (broadcast) => {
			if (!closed) receive(broadcast);
		},
		onOnline: () => {
			online = true;
			connection++;
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
		const on = connection;
		/** A call failed: the device is offline, unless the link came back meanwhile and a new step runs. */
		const lost = () => {
			if (connection === on) online = false;
			needsHello = true;
		};
		if (needsHello) {
			const welcome = await link.hello(position());
			if (welcome.error !== null) {
				lost();
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
			const next = first<{ n: number; seq: number; policy: Policy; changes: string }>(
				driver,
				'SELECT n, seq, policy, changes FROM "epicenter/outbox" ORDER BY n LIMIT 1',
			);
			if (next === undefined) return;
			const entries = JSON.parse(next.changes) as Entry[];
			const batchOf = (withBases: boolean): Batch => ({
				device,
				n: next.n,
				seq: next.seq,
				policy: next.policy,
				changes: entries.map(({ change }): Change =>
					withBases || change.kind === 'move' || change.base === null ? change : { ...change, base: { hash: change.base.hash } },
				),
			});
			// From here the batch may reach the server, so it is never changed
			// again, unless the transport says it never left this device.
			const before = sentThrough();
			if (next.n > before) setMeta('sent', String(next.n));
			let answer = await link.push(batchOf(false));
			if (answer.error !== null && !answer.error.sent && sentThrough() === next.n) setMeta('sent', String(before));
			if (answer.error === null && answer.data.kind === 'need-base') answer = await link.push(batchOf(true));
			if (answer.error !== null) {
				lost();
				// Every waiting send's row stays and is sent again; its caller cannot know the verdict now.
				for (const n of [...verdicts.keys()]) verdictUnknown(n);
				return;
			}
			if (closed) return;
			if (next.policy === 'refuse') concludeSend(next.n, entries, answer.data);
			else conclude(next.n, entries, answer.data);
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
		return driver
			.all<ReadRow>(
				`SELECT ${READ_COLUMNS('f')} FROM "epicenter/files" f JOIN temp."${lens.name}" v ON v.path = f.path${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY f.path`,
				keys.map(([, value]) => String(value)),
			)
			.map(withVersion);
	}

	function fileRow(path: string): FileRead | null {
		const found = first<ReadRow>(driver, `SELECT ${READ_COLUMNS('f')} FROM "epicenter/files" f WHERE f.path = ? AND f.text IS NOT NULL`, [path]);
		return found === undefined ? null : withVersion(found);
	}

	function getRow(lens: Lens, params: Params): FileRead | null {
		const path = split(lens, params);
		return path.error === null ? fileRow(path.data) : null;
	}

	async function read<TRequest extends EngineRequest>(request: TRequest): Promise<EngineAnswers[TRequest['kind']]> {
		type Answer = EngineAnswers[TRequest['kind']];
		switch (request.kind) {
			case 'get':
				return getRow(lensOf(request.name), request.params) as Answer;
			case 'file':
				return fileRow(request.path) as Answer;
			case 'list':
				return listRows(lensOf(request.name), request.filter) as Answer;
			case 'query':
				return driver.read(request.sql, request.params) as Answer;
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
		/** Apply writes here now and send them; see `apply`. */
		submit,
		/** Send one batch that refuses on overlap and wait for the verdict; see `send`. */
		send,
		/** Remove a notice the person has seen. */
		dismiss: async (id: number) => dismiss(id),
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
			for (const n of [...verdicts.keys()]) verdictUnknown(n);
		},
	};
}
export type Engine = ReturnType<typeof openEngine>;
