/**
 * Durable run records and events. WAL with synchronous=FULL syncs each commit;
 * durability assumes the OS honours fsync. secure_delete overwrites freed SQLite
 * pages, not necessarily copies retained by the storage device.
 */
import { Database } from 'bun:sqlite';
import { chmodSync, closeSync, openSync, statSync } from 'node:fs';

export type RunFiles = Record<
	string,
	{ name: string; type: string; size: number; sha256: string }
>;
export type RunState = 'accepted' | 'running' | 'finished' | 'interrupted';
export type RunRecord = {
	version: 1;
	app: string;
	id: string;
	action: string;
	inputDigest?: string;
	acceptedAt: string;
	state: RunState;
	endedAt?: string;
	lastSeq: number;
	logBytes: number;
	files: RunFiles;
};
/** Stored answers retain the wire format of the release that wrote them. */
export type EventFields<A = unknown> =
	| { type: 'accepted' | 'started' | 'cancel-requested' }
	| { type: 'yielded'; value: unknown }
	| { type: 'finished'; answer: A }
	| { type: 'interrupted'; message: string };
export type HostEvent = EventFields & { seq: number; at: string };
export class LogFull extends Error {
	constructor() {
		super('The run event log would exceed 4 MiB');
		this.name = 'LogFull';
	}
}
type Row = {
	app: string;
	id: string;
	action: string;
	input_digest: string | null;
	state: RunState;
	accepted_at: string;
	ended_at: number | null;
	last_seq: number;
	log_bytes: number;
	files: string;
};
type EventRow = {
	seq: number;
	at: string;
	type: HostEvent['type'];
	gzip: number | null;
	body: Uint8Array | null;
};
const decodeRecord = (row: Row): RunRecord => ({
	version: 1,
	app: row.app,
	id: row.id,
	action: row.action,
	...(row.input_digest === null ? {} : { inputDigest: row.input_digest }),
	acceptedAt: row.accepted_at,
	state: row.state,
	...(row.ended_at === null
		? {}
		: { endedAt: new Date(row.ended_at).toISOString() }),
	lastSeq: row.last_seq,
	logBytes: row.log_bytes,
	files: JSON.parse(row.files),
});
const payloadKey = (type: HostEvent['type']) =>
	type === 'yielded'
		? 'value'
		: type === 'finished'
			? 'answer'
			: type === 'interrupted'
				? 'message'
				: undefined;

export function openRunStore({ path }: { path: string }) {
	closeSync(openSync(path, 'a', 0o600));
	chmodSync(path, 0o600);
	const db = new Database(path, { create: true, strict: true });
	db.exec(
		'PRAGMA auto_vacuum=INCREMENTAL; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON; PRAGMA journal_size_limit=16777216; PRAGMA busy_timeout=1000;',
	);
	const version = db
		.query<{ user_version: number }, []>('PRAGMA user_version')
		.get()?.user_version;
	if (version !== 0 && version !== 1)
		throw new Error(`Unsupported run store version: ${version}`);
	db.exec(`CREATE TABLE IF NOT EXISTS runs (app TEXT NOT NULL, id TEXT NOT NULL, action TEXT NOT NULL, input_digest TEXT, state TEXT NOT NULL CHECK(state IN ('accepted','running','finished','interrupted')), accepted_at TEXT NOT NULL, ended_at INTEGER, last_seq INTEGER NOT NULL DEFAULT 0, log_bytes INTEGER NOT NULL DEFAULT 0, files TEXT NOT NULL, PRIMARY KEY(app,id));
		CREATE INDEX IF NOT EXISTS runs_ended ON runs(ended_at) WHERE ended_at IS NOT NULL;
		CREATE TABLE IF NOT EXISTS payloads (hash TEXT PRIMARY KEY, gzip INTEGER NOT NULL, body BLOB NOT NULL);
		CREATE TABLE IF NOT EXISTS events (app TEXT NOT NULL, id TEXT NOT NULL, seq INTEGER NOT NULL, at TEXT NOT NULL, type TEXT NOT NULL, payload TEXT REFERENCES payloads(hash), PRIMARY KEY(app,id,seq)) WITHOUT ROWID;
		CREATE INDEX IF NOT EXISTS events_payload ON events(payload) WHERE payload IS NOT NULL;
		PRAGMA user_version=1;`);
	chmodSync(path, 0o600);
	const select = db.query<Row, [string, string]>(
		'SELECT * FROM runs WHERE app=? AND id=?',
	);
	function record(app: string, id: string) {
		const row = select.get(app, id);
		return row ? decodeRecord(row) : undefined;
	}
	function insertEvent(app: string, id: string, event: HostEvent) {
		const key = payloadKey(event.type);
		let hash: string | null = null;
		if (key) {
			const text = JSON.stringify(
				(event as unknown as Record<string, unknown>)[key],
			);
			if (text === undefined) throw new Error('Event payload is not JSON');
			const raw = Buffer.from(text);
			const compressed = raw.length > 1024 ? Bun.gzipSync(raw) : raw;
			const gzip = compressed.length < raw.length ? 1 : 0;
			hash = new Bun.CryptoHasher('sha256').update(raw).digest('hex');
			db.run('INSERT OR IGNORE INTO payloads(hash,gzip,body) VALUES(?,?,?)', [
				hash,
				gzip,
				gzip ? compressed : raw,
			]);
		}
		db.run(
			'INSERT INTO events(app,id,seq,at,type,payload) VALUES(?,?,?,?,?,?)',
			[app, id, event.seq, event.at, event.type, hash],
		);
	}
	function events(app: string, id: string, after: number): HostEvent[] {
		const rows = db
			.query<EventRow, [string, string, number]>(
				'SELECT e.seq,e.at,e.type,p.gzip,p.body FROM events e LEFT JOIN payloads p ON p.hash=e.payload WHERE e.app=? AND e.id=? AND e.seq>? ORDER BY e.seq',
			)
			.all(app, id, after);
		return rows.map((row) => {
			const key = payloadKey(row.type);
			const value =
				key && row.body
					? JSON.parse(
							Buffer.from(
								row.gzip ? Bun.gunzipSync(new Uint8Array(row.body)) : row.body,
							).toString('utf8'),
						)
					: undefined;
			return {
				seq: row.seq,
				at: row.at,
				type: row.type,
				...(key ? { [key]: value } : {}),
			} as HostEvent;
		});
	}
	const append = db.transaction(
		(
			app: string,
			id: string,
			fields: EventFields & { at?: string },
			{ limit }: { limit: number },
		) => {
			const current = record(app, id);
			if (!current) throw new Error('Unknown run');
			if (current.state === 'finished' || current.state === 'interrupted')
				throw new Error('Run is terminal');
			const { at = new Date().toISOString(), ...rest } = fields;
			const json = JSON.stringify({ seq: current.lastSeq + 1, at, ...rest });
			const bytes = Buffer.byteLength(json) + 1;
			if (current.logBytes + bytes > limit) throw new LogFull();
			const event = JSON.parse(json) as HostEvent;
			insertEvent(app, id, event);
			const state =
				event.type === 'started'
					? 'running'
					: event.type === 'finished' || event.type === 'interrupted'
						? event.type
						: current.state;
			const ended =
				state === 'finished' || state === 'interrupted' ? Date.parse(at) : null;
			db.run(
				'UPDATE runs SET last_seq=?, log_bytes=?, state=?, ended_at=? WHERE app=? AND id=?',
				[event.seq, current.logBytes + bytes, state, ended, app, id],
			);
			return event;
		},
	);
	const admit = db.transaction(
		(input: {
			app: string;
			id: string;
			action: string;
			inputDigest?: string;
			files: RunFiles;
			at: string;
		}) => {
			const existing = record(input.app, input.id);
			if (existing) return { existing };
			db.run(
				'INSERT INTO runs(app,id,action,input_digest,state,accepted_at,files) VALUES(?,?,?,?,?,?,?)',
				[
					input.app,
					input.id,
					input.action,
					input.inputDigest ?? null,
					'accepted',
					input.at,
					JSON.stringify(input.files),
				],
			);
			const event = append(
				input.app,
				input.id,
				{ type: 'accepted', at: input.at },
				{ limit: Number.MAX_SAFE_INTEGER },
			);
			return { created: record(input.app, input.id)!, event };
		},
	);
	const expire = db.transaction(
		(cutoff: number, protectedKeys: Set<string> = new Set()) => {
			const rows = db
				.query<{ app: string; id: string }, [number]>(
					'SELECT app,id FROM runs WHERE ended_at < ?',
				)
				.all(cutoff);
			const hashes = db.query<{ payload: string }, [string, string]>(
				'SELECT DISTINCT payload FROM events WHERE app=? AND id=? AND payload IS NOT NULL',
			);
			const candidates = new Set<string>();
			const expired = rows.filter(
				(row) => !protectedKeys.has(`${row.app}/${row.id}`),
			);
			for (const row of expired) {
				for (const item of hashes.all(row.app, row.id))
					candidates.add(item.payload);
				db.run('DELETE FROM events WHERE app=? AND id=?', [row.app, row.id]);
				db.run('DELETE FROM runs WHERE app=? AND id=?', [row.app, row.id]);
			}
			for (const hash of candidates)
				db.run(
					'DELETE FROM payloads WHERE hash=? AND NOT EXISTS (SELECT 1 FROM events WHERE payload=?)',
					[hash, hash],
				);
			return expired;
		},
	);
	function sizes() {
		return [path, `${path}-wal`, `${path}-shm`].reduce((sum, name) => {
			try {
				return sum + statSync(name).size;
			} catch (cause) {
				if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return sum;
				throw cause;
			}
		}, 0);
	}
	return {
		admit,
		record,
		nonTerminal: () =>
			db
				.query<Row, []>(
					"SELECT * FROM runs WHERE state IN ('accepted','running')",
				)
				.all()
				.map(decodeRecord),
		append,
		events,
		expire,
		sizes,
		compact() {
			db.exec('PRAGMA incremental_vacuum; PRAGMA wal_checkpoint(TRUNCATE);');
			return sizes();
		},
		close() {
			db.close();
		},
	};
}
export type RunStore = ReturnType<typeof openRunStore>;
