/**
 * The four SQLite layout candidates and their stores.
 *
 * A candidate is a cross of relation layout (one unified `facts` table, or split
 * `row_facts` / `value_facts`) and coordinate layout (inline structured
 * coordinates, or a normalized `coordinates` dictionary). The confirmed-facts DDL
 * is the proven shape from the historical monolith. The coordinate decision
 * applies to EVERY address-bearing owner table, so the auxiliary tables (pending
 * intents, parked work, row documents) carry the same inline-vs-normalized choice
 * and share the one coordinates dictionary under the normalized candidates.
 *
 * The store maps the V1-bound trace `Fact` to columns, installs confirmed facts
 * monotonically, populates the auxiliary tables from the auxiliary traces, and
 * reproduces the analytical oracle witness by scanning `ORDER BY sequence`. That
 * witness reproduction is the INDEPENDENT correctness proof; a candidate agreeing
 * with a peer or with its own reopen is consistency, checked separately. Storage
 * is measured per candidate-varying table via `dbstat`, the true candidate-table
 * bytes, never a whole-database page count.
 */

import type { Database, SQLQueryBindings } from 'bun:sqlite';

import { canonicalize } from '../../../packages/data/src/protocol/v1/canonical.js';
import type { AuxiliaryTraces, DocumentEntry } from './auxiliary-traces.js';
import { Sha256Stream } from './portable-hash.js';
import type { Address, Fact, RowAddress, ValueAddress } from './trace.js';
import { canonicalFactRecord, utf8Len } from './trace.js';

export type RelationLayout = 'unified' | 'split';
export type CoordinateLayout = 'inline' | 'normalized';

export type Candidate = {
	id: string;
	relation: RelationLayout;
	coordinates: CoordinateLayout;
};

export const CANDIDATES: readonly Candidate[] = [
	{ id: 'unified-inline', relation: 'unified', coordinates: 'inline' },
	{ id: 'unified-normalized', relation: 'unified', coordinates: 'normalized' },
	{ id: 'split-inline', relation: 'split', coordinates: 'inline' },
	{ id: 'split-normalized', relation: 'split', coordinates: 'normalized' },
];

const SAFE_SEQUENCE_MAX = Number.MAX_SAFE_INTEGER;
const PAGE_SIZE = 4096;
const CACHE_KIB = 16 * 1024;

/** One confirmed fact projected to physical columns. */
type Row = {
	kind: 'row' | 'value';
	namespace: string;
	localKey: string;
	rowId: string;
	present: 0 | 1;
	payload: string | null;
	sequence: number;
};

function factToRow(fact: Fact): Row {
	if (fact.address.kind === 'row') {
		return {
			kind: 'row',
			namespace: fact.address.namespace,
			localKey: fact.address.table,
			rowId: fact.address.rowId,
			present: fact.presence === 'present' ? 1 : 0,
			payload:
				fact.presence === 'present' && 'fields' in fact
					? canonicalize(fact.fields)
					: null,
			sequence: fact.sequence,
		};
	}
	return {
		kind: 'value',
		namespace: fact.address.namespace,
		localKey: fact.address.value,
		rowId: '',
		present: fact.presence === 'present' ? 1 : 0,
		payload:
			fact.presence === 'present' && 'content' in fact
				? canonicalize(fact.content)
				: null,
		sequence: fact.sequence,
	};
}

function addressColumns(address: Address): {
	kind: 'row' | 'value';
	namespace: string;
	localKey: string;
	rowId: string;
} {
	return address.kind === 'row'
		? {
				kind: 'row',
				namespace: address.namespace,
				localKey: address.table,
				rowId: address.rowId,
			}
		: {
				kind: 'value',
				namespace: address.namespace,
				localKey: address.value,
				rowId: '',
			};
}

// --- DDL (confirmed facts adapted from the proven monolith) ------------------

function factCheck(kindExpression: string): string {
	return `CHECK (
		CASE
			WHEN ${kindExpression} = 'row' AND present = 1 THEN
				typeof(present) = 'integer' AND typeof(payload) = 'text' AND json_valid(payload) = 1 AND json_type(payload) = 'object'
			WHEN ${kindExpression} = 'row' AND present = 0 THEN payload IS NULL
			WHEN ${kindExpression} = 'value' AND present = 1 THEN
				typeof(present) = 'integer' AND typeof(payload) = 'text' AND json_valid(payload) = 1
			WHEN ${kindExpression} = 'value' AND present = 0 THEN payload IS NULL
			ELSE 0
		END
	)`;
}
const fixedKindCheck = (kind: 'row' | 'value') => factCheck(`'${kind}'`);

function splitSequenceTriggers(): string {
	return `
		CREATE TRIGGER row_sequence_insert BEFORE INSERT ON row_facts
		WHEN EXISTS (SELECT 1 FROM value_facts WHERE sequence = NEW.sequence)
		BEGIN SELECT RAISE(ABORT, 'cross-table sequence collision'); END;
		CREATE TRIGGER value_sequence_insert BEFORE INSERT ON value_facts
		WHEN EXISTS (SELECT 1 FROM row_facts WHERE sequence = NEW.sequence)
		BEGIN SELECT RAISE(ABORT, 'cross-table sequence collision'); END;
	`;
}

function confirmedFactsDdl(candidate: Candidate): string {
	const sequence = `CHECK (typeof(sequence) = 'integer' AND sequence >= 1 AND sequence <= ${SAFE_SEQUENCE_MAX})`;
	const rowIdCheck =
		"typeof(row_id) = 'text' AND length(row_id) = 24 AND row_id NOT GLOB '*[^a-z0-9]*'";
	const textCheck = (column: string) =>
		`typeof(${column}) = 'text' AND length(${column}) > 0`;
	if (candidate.relation === 'unified' && candidate.coordinates === 'inline') {
		return `
			CREATE TABLE facts (
				kind TEXT NOT NULL CHECK (kind IN ('row', 'value')),
				namespace TEXT NOT NULL CHECK (${textCheck('namespace')}),
				local_key TEXT NOT NULL CHECK (${textCheck('local_key')}),
				row_id TEXT NOT NULL,
				present INTEGER NOT NULL CHECK (present IN (0, 1)),
				payload TEXT,
				sequence INTEGER NOT NULL UNIQUE ${sequence},
				CHECK (CASE kind WHEN 'row' THEN ${rowIdCheck} WHEN 'value' THEN row_id = '' ELSE 0 END),
				${factCheck('kind')},
				PRIMARY KEY (kind, namespace, local_key, row_id)
			) WITHOUT ROWID;
		`;
	}
	if (candidate.relation === 'unified') {
		return `
			CREATE TABLE facts (
				coordinate_id INTEGER NOT NULL REFERENCES coordinates(coordinate_id),
				row_id TEXT NOT NULL,
				present INTEGER NOT NULL CHECK (present IN (0, 1)),
				payload TEXT,
				sequence INTEGER NOT NULL UNIQUE ${sequence},
				PRIMARY KEY (coordinate_id, row_id)
			) WITHOUT ROWID;
		`;
	}
	const rowCoord =
		candidate.coordinates === 'normalized'
			? 'coordinate_id INTEGER NOT NULL REFERENCES coordinates(coordinate_id),'
			: `namespace TEXT NOT NULL CHECK (${textCheck('namespace')}),\n\t\t\tlocal_key TEXT NOT NULL CHECK (${textCheck('local_key')}),`;
	const rowPrimary =
		candidate.coordinates === 'normalized'
			? 'PRIMARY KEY (coordinate_id, row_id)'
			: 'PRIMARY KEY (namespace, local_key, row_id)';
	const valuePrimary =
		candidate.coordinates === 'normalized'
			? 'PRIMARY KEY (coordinate_id)'
			: 'PRIMARY KEY (namespace, local_key)';
	return `
		CREATE TABLE row_facts (
			${rowCoord}
			row_id TEXT NOT NULL CHECK (${rowIdCheck}),
			present INTEGER NOT NULL CHECK (present IN (0, 1)),
			payload TEXT,
			sequence INTEGER NOT NULL UNIQUE ${sequence},
			${fixedKindCheck('row')},
			${rowPrimary}
		) WITHOUT ROWID;
		CREATE TABLE value_facts (
			${rowCoord}
			present INTEGER NOT NULL CHECK (present IN (0, 1)),
			payload TEXT,
			sequence INTEGER NOT NULL UNIQUE ${sequence},
			${fixedKindCheck('value')},
			${valuePrimary}
		) WITHOUT ROWID;
		${splitSequenceTriggers()}
	`;
}

/** Coordinate dictionary plus coordinate-aware auxiliary tables. */
function coordinateAndAuxiliaryDdl(candidate: Candidate): string {
	const normalized = candidate.coordinates === 'normalized';
	const coordinates = normalized
		? `CREATE TABLE coordinates (
			coordinate_id INTEGER PRIMARY KEY,
			kind TEXT NOT NULL CHECK (kind IN ('row', 'value')),
			namespace TEXT NOT NULL,
			local_key TEXT NOT NULL,
			UNIQUE (kind, namespace, local_key)
		);`
		: '';
	// Address columns are inline or a coordinate reference, so the auxiliary tables
	// honor the same coordinate decision as the confirmed facts.
	const addr = normalized
		? 'coordinate_id INTEGER NOT NULL REFERENCES coordinates(coordinate_id), row_id TEXT NOT NULL'
		: 'kind TEXT NOT NULL, namespace TEXT NOT NULL, local_key TEXT NOT NULL, row_id TEXT NOT NULL';
	const addrPk = normalized
		? '(coordinate_id, row_id)'
		: '(kind, namespace, local_key, row_id)';
	const docAddr = normalized
		? 'coordinate_id INTEGER NOT NULL REFERENCES coordinates(coordinate_id), row_id TEXT NOT NULL'
		: 'namespace TEXT NOT NULL, table_key TEXT NOT NULL, row_id TEXT NOT NULL';
	const docPk = normalized
		? '(coordinate_id, row_id)'
		: '(namespace, table_key, row_id)';
	return `
		${coordinates}
		CREATE TABLE pending_intents (
			${addr},
			present INTEGER NOT NULL CHECK (present IN (0, 1)),
			payload TEXT,
			PRIMARY KEY ${addrPk}
		) WITHOUT ROWID;
		CREATE TABLE parked_work (
			${addr},
			code TEXT NOT NULL,
			measured_bytes INTEGER NOT NULL,
			limit_bytes INTEGER NOT NULL,
			PRIMARY KEY ${addrPk}
		) WITHOUT ROWID;
		CREATE TABLE row_documents (
			${docAddr},
			baseline BLOB NOT NULL,
			tail BLOB NOT NULL,
			PRIMARY KEY ${docPk}
		) WITHOUT ROWID;
		CREATE TABLE retry_ledger (
			replica_id TEXT NOT NULL PRIMARY KEY,
			last_submission INTEGER NOT NULL,
			request_hash TEXT NOT NULL
		) WITHOUT ROWID;
	`;
}

export function ddlFor(candidate: Candidate): string {
	return `${coordinateAndAuxiliaryDdl(candidate)}\n${confirmedFactsDdl(candidate)}`;
}

/** The DDL hash pins the exact physical schema behind a candidate's evidence. */
export function ddlHash(candidate: Candidate): string {
	const ddl = ddlFor(candidate);
	return new Sha256Stream().update(ddl).digestHex();
}

// --- Database configuration --------------------------------------------------

export function configureNewDatabase(database: Database): void {
	database.exec(`PRAGMA page_size=${PAGE_SIZE}`);
	database.exec(`PRAGMA cache_size=-${CACHE_KIB}`);
	database.exec('PRAGMA foreign_keys=ON');
	database.exec('PRAGMA journal_mode=WAL');
	database.exec('PRAGMA synchronous=NORMAL');
	database.exec('PRAGMA temp_store=MEMORY');
}

export function configureReopenedDatabase(database: Database): void {
	database.exec(`PRAGMA cache_size=-${CACHE_KIB}`);
	database.exec('PRAGMA foreign_keys=ON');
	database.exec('PRAGMA synchronous=NORMAL');
	database.exec('PRAGMA temp_store=MEMORY');
}

// --- Store -------------------------------------------------------------------

export type OracleWitness = { count: number; bytes: number; digestHex: string };

export type LayoutStore = {
	installFacts(facts: Iterable<Fact>): void;
	populateAuxiliary(aux: AuxiliaryTraces): void;
	/** Reproduce the analytical oracle witness by scanning ORDER BY sequence. */
	scanWitness(): OracleWitness;
	/** Read one current fact's presence and sequence, or null. */
	pointRead(address: Address): { present: 0 | 1; sequence: number } | null;
	/** Candidate-varying table bytes via dbstat (true candidate-table storage). */
	candidateTableBytes(): number;
	finalize(): void;
};

export function createLayoutStore(
	database: Database,
	candidate: Candidate,
): LayoutStore {
	const prepared: Array<{ finalize(): void }> = [];
	const prepare = (sql: string) => {
		const stmt = database.prepare(sql);
		prepared.push(stmt);
		return stmt;
	};
	const normalized = candidate.coordinates === 'normalized';

	const coordinateCache = new Map<string, number>();
	const coordinateInsert = normalized
		? prepare(
				'INSERT OR IGNORE INTO coordinates (kind, namespace, local_key) VALUES (?, ?, ?)',
			)
		: null;
	const coordinateSelect = normalized
		? prepare(
				'SELECT coordinate_id FROM coordinates WHERE kind = ? AND namespace = ? AND local_key = ?',
			)
		: null;

	function coordinateId(
		kind: string,
		namespace: string,
		localKey: string,
	): number {
		const key = `${kind} ${namespace} ${localKey}`;
		const cached = coordinateCache.get(key);
		if (cached !== undefined) return cached;
		if (coordinateInsert === null || coordinateSelect === null) {
			throw new Error('normalized coordinate statements unavailable');
		}
		coordinateInsert.run(kind, namespace, localKey);
		const found = coordinateSelect.get(kind, namespace, localKey) as {
			coordinate_id: number;
		} | null;
		if (found === null) throw new Error(`coordinate lookup failed: ${key}`);
		coordinateCache.set(key, found.coordinate_id);
		return found.coordinate_id;
	}

	// Confirmed-fact writer: all relation/coordinate/kind branching is encapsulated
	// so callers never touch a possibly-absent statement.
	const factWriter = buildFactWriter(prepare, candidate);
	const installFact = (row: Row): void =>
		factWriter.run(row, (kind, ns, lk) => coordinateId(kind, ns, lk));

	// Auxiliary insert statements, coordinate-aware.
	const pendingStmt = normalized
		? prepare(
				'INSERT OR REPLACE INTO pending_intents (coordinate_id, row_id, present, payload) VALUES (?, ?, ?, ?)',
			)
		: prepare(
				'INSERT OR REPLACE INTO pending_intents (kind, namespace, local_key, row_id, present, payload) VALUES (?, ?, ?, ?, ?, ?)',
			);
	const parkedStmt = normalized
		? prepare(
				'INSERT OR REPLACE INTO parked_work (coordinate_id, row_id, code, measured_bytes, limit_bytes) VALUES (?, ?, ?, ?, ?)',
			)
		: prepare(
				'INSERT OR REPLACE INTO parked_work (kind, namespace, local_key, row_id, code, measured_bytes, limit_bytes) VALUES (?, ?, ?, ?, ?, ?, ?)',
			);
	const documentStmt = normalized
		? prepare(
				'INSERT OR REPLACE INTO row_documents (coordinate_id, row_id, baseline, tail) VALUES (?, ?, ?, ?)',
			)
		: prepare(
				'INSERT OR REPLACE INTO row_documents (namespace, table_key, row_id, baseline, tail) VALUES (?, ?, ?, ?, ?)',
			);
	const retryStmt = prepare(
		'INSERT OR REPLACE INTO retry_ledger (replica_id, last_submission, request_hash) VALUES (?, ?, ?)',
	);

	function insertPendingOrParked(
		stmt: ReturnType<typeof prepare>,
		address: Address,
		tail: SQLQueryBindings[],
	): void {
		const cols = addressColumns(address);
		const args: SQLQueryBindings[] = normalized
			? [
					coordinateId(cols.kind, cols.namespace, cols.localKey),
					cols.rowId,
					...tail,
				]
			: [cols.kind, cols.namespace, cols.localKey, cols.rowId, ...tail];
		stmt.run(...args);
	}

	function insertDocument(entry: DocumentEntry): void {
		const baseline = new Uint8Array(entry.baselineBytes);
		const tail = new Uint8Array(entry.tailBytes);
		if (normalized) {
			const id = coordinateId(
				'row',
				entry.address.namespace,
				entry.address.table,
			);
			documentStmt.run(id, entry.address.rowId, baseline, tail);
		} else {
			documentStmt.run(
				entry.address.namespace,
				entry.address.table,
				entry.address.rowId,
				baseline,
				tail,
			);
		}
	}

	const pointStore = buildPointStatements(prepare, candidate);

	return {
		installFacts(facts) {
			const run = database.transaction((all: Iterable<Fact>) => {
				for (const fact of all) installFact(factToRow(fact));
			});
			run(facts);
		},
		populateAuxiliary(aux) {
			const run = database.transaction(() => {
				for (const intent of aux.pending.entries) {
					const present = intent.presence === 'present' ? 1 : 0;
					const payload =
						intent.presence === 'present'
							? 'set' in intent
								? canonicalize(intent.set)
								: canonicalize(intent.content)
							: null;
					insertPendingOrParked(pendingStmt, intent.address, [
						present,
						payload,
					]);
				}
				for (const parked of aux.parked.entries) {
					insertPendingOrParked(parkedStmt, parked.address, [
						parked.code,
						parked.measuredBytes,
						parked.limitBytes,
					]);
				}
				for (const doc of aux.document.entries) insertDocument(doc);
				for (const retry of aux.retry.entries) {
					retryStmt.run(
						retry.replicaId,
						retry.lastSubmissionNumber,
						retry.requestHashHex,
					);
				}
			});
			run();
		},
		scanWitness() {
			const hasher = new Sha256Stream();
			let count = 0;
			let bytes = 0;
			for (const fact of pointStore.scan()) {
				const record = canonicalFactRecord(fact);
				const recordBytes = utf8Len(record);
				hasher.update(`${recordBytes}:${record}\n`);
				count += 1;
				bytes += recordBytes;
			}
			return { count, bytes, digestHex: hasher.digestHex() };
		},
		pointRead(address) {
			return pointStore.point(address);
		},
		candidateTableBytes() {
			const rows = database
				.prepare(
					`SELECT SUM(pgsize) AS bytes FROM dbstat WHERE name IN (${CANDIDATE_TABLE_NAMES.map(() => '?').join(',')})`,
				)
				.get(...CANDIDATE_TABLE_NAMES) as { bytes: number | null };
			return rows.bytes ?? 0;
		},
		finalize() {
			for (const stmt of prepared) stmt.finalize();
		},
	};
}

const CANDIDATE_TABLE_NAMES = [
	'facts',
	'row_facts',
	'value_facts',
	'coordinates',
	'pending_intents',
	'parked_work',
	'row_documents',
	'retry_ledger',
];

// --- Statement builders ------------------------------------------------------

type Prepare = (sql: string) => ReturnType<Database['prepare']>;

type ResolveCoordinate = (
	kind: string,
	namespace: string,
	localKey: string,
) => number;

/** A confirmed-fact writer that hides all relation/coordinate/kind branching. */
function buildFactWriter(
	prepare: Prepare,
	candidate: Candidate,
): { run(row: Row, resolve: ResolveCoordinate): void } {
	const set =
		'present=excluded.present, payload=excluded.payload, sequence=excluded.sequence';
	if (candidate.relation === 'unified') {
		if (candidate.coordinates === 'inline') {
			const stmt = prepare(
				`INSERT INTO facts (kind, namespace, local_key, row_id, present, payload, sequence) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(kind, namespace, local_key, row_id) DO UPDATE SET ${set}`,
			);
			return {
				run(row) {
					stmt.run(
						row.kind,
						row.namespace,
						row.localKey,
						row.rowId,
						row.present,
						row.payload,
						row.sequence,
					);
				},
			};
		}
		const stmt = prepare(
			`INSERT INTO facts (coordinate_id, row_id, present, payload, sequence) VALUES (?, ?, ?, ?, ?) ON CONFLICT(coordinate_id, row_id) DO UPDATE SET ${set}`,
		);
		return {
			run(row, resolve) {
				stmt.run(
					resolve(row.kind, row.namespace, row.localKey),
					row.rowId,
					row.present,
					row.payload,
					row.sequence,
				);
			},
		};
	}
	if (candidate.coordinates === 'inline') {
		const rowStmt = prepare(
			`INSERT INTO row_facts (namespace, local_key, row_id, present, payload, sequence) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(namespace, local_key, row_id) DO UPDATE SET ${set}`,
		);
		const valueStmt = prepare(
			`INSERT INTO value_facts (namespace, local_key, present, payload, sequence) VALUES (?, ?, ?, ?, ?) ON CONFLICT(namespace, local_key) DO UPDATE SET ${set}`,
		);
		return {
			run(row) {
				if (row.kind === 'row') {
					rowStmt.run(
						row.namespace,
						row.localKey,
						row.rowId,
						row.present,
						row.payload,
						row.sequence,
					);
				} else {
					valueStmt.run(
						row.namespace,
						row.localKey,
						row.present,
						row.payload,
						row.sequence,
					);
				}
			},
		};
	}
	const rowStmt = prepare(
		`INSERT INTO row_facts (coordinate_id, row_id, present, payload, sequence) VALUES (?, ?, ?, ?, ?) ON CONFLICT(coordinate_id, row_id) DO UPDATE SET ${set}`,
	);
	const valueStmt = prepare(
		`INSERT INTO value_facts (coordinate_id, present, payload, sequence) VALUES (?, ?, ?, ?) ON CONFLICT(coordinate_id) DO UPDATE SET ${set}`,
	);
	return {
		run(row, resolve) {
			const id = resolve(row.kind, row.namespace, row.localKey);
			if (row.kind === 'row') {
				rowStmt.run(id, row.rowId, row.present, row.payload, row.sequence);
			} else {
				valueStmt.run(id, row.present, row.payload, row.sequence);
			}
		},
	};
}

function buildPointStatements(prepare: Prepare, candidate: Candidate) {
	// Scan every current fact in ascending sequence, reconstructing the V1 Fact.
	const scanSql = scanSqlFor(candidate);
	const scanStmt = prepare(scanSql);
	const pointSql = pointSqlFor(candidate);
	const pointStmt = prepare(pointSql.sql);

	function reconstruct(raw: {
		kind: string;
		namespace: string;
		local_key: string;
		row_id: string;
		present: number;
		payload: string | null;
		sequence: number;
	}): Fact {
		if (raw.kind === 'row') {
			const address: RowAddress = {
				kind: 'row',
				namespace: raw.namespace,
				table: raw.local_key,
				rowId: raw.row_id,
			};
			return raw.present === 1
				? {
						address,
						sequence: raw.sequence,
						presence: 'present',
						fields: JSON.parse(raw.payload ?? '{}'),
					}
				: { address, sequence: raw.sequence, presence: 'absent' };
		}
		const address: ValueAddress = {
			kind: 'value',
			namespace: raw.namespace,
			value: raw.local_key,
		};
		return raw.present === 1
			? {
					address,
					sequence: raw.sequence,
					presence: 'present',
					content: JSON.parse(raw.payload ?? 'null'),
				}
			: { address, sequence: raw.sequence, presence: 'absent' };
	}

	return {
		*scan(): Generator<Fact> {
			for (const raw of scanStmt.all() as Array<
				Parameters<typeof reconstruct>[0]
			>) {
				yield reconstruct(raw);
			}
		},
		point(address: Address): { present: 0 | 1; sequence: number } | null {
			const cols = addressColumns(address);
			const found = pointSql.bind(pointStmt, cols) as {
				present: 0 | 1;
				sequence: number;
			} | null;
			return found ?? null;
		},
	};
}

function scanSqlFor(candidate: Candidate): string {
	if (candidate.relation === 'unified') {
		return candidate.coordinates === 'inline'
			? 'SELECT kind, namespace, local_key, row_id, present, payload, sequence FROM facts ORDER BY sequence'
			: `SELECT c.kind AS kind, c.namespace AS namespace, c.local_key AS local_key, f.row_id AS row_id, f.present AS present, f.payload AS payload, f.sequence AS sequence
				FROM facts f JOIN coordinates c USING (coordinate_id) ORDER BY f.sequence`;
	}
	if (candidate.coordinates === 'inline') {
		return `SELECT * FROM (
				SELECT 'row' AS kind, namespace, local_key, row_id, present, payload, sequence FROM row_facts
				UNION ALL
				SELECT 'value' AS kind, namespace, local_key, '' AS row_id, present, payload, sequence FROM value_facts
			) ORDER BY sequence`;
	}
	return `SELECT * FROM (
			SELECT c.kind AS kind, c.namespace AS namespace, c.local_key AS local_key, f.row_id AS row_id, f.present AS present, f.payload AS payload, f.sequence AS sequence
			FROM row_facts f JOIN coordinates c USING (coordinate_id)
			UNION ALL
			SELECT c.kind AS kind, c.namespace AS namespace, c.local_key AS local_key, '' AS row_id, f.present AS present, f.payload AS payload, f.sequence AS sequence
			FROM value_facts f JOIN coordinates c USING (coordinate_id)
		) ORDER BY sequence`;
}

function pointSqlFor(candidate: Candidate): {
	sql: string;
	bind: (
		stmt: ReturnType<Database['prepare']>,
		cols: { kind: string; namespace: string; localKey: string; rowId: string },
	) => unknown;
} {
	if (candidate.relation === 'unified') {
		if (candidate.coordinates === 'inline') {
			return {
				sql: 'SELECT present, sequence FROM facts WHERE kind=? AND namespace=? AND local_key=? AND row_id=?',
				bind: (stmt, c) => stmt.get(c.kind, c.namespace, c.localKey, c.rowId),
			};
		}
		return {
			sql: 'SELECT f.present AS present, f.sequence AS sequence FROM facts f JOIN coordinates c USING(coordinate_id) WHERE c.kind=? AND c.namespace=? AND c.local_key=? AND f.row_id=?',
			bind: (stmt, c) => stmt.get(c.kind, c.namespace, c.localKey, c.rowId),
		};
	}
	if (candidate.coordinates === 'inline') {
		return {
			sql: `SELECT present, sequence FROM row_facts WHERE namespace=?1 AND local_key=?2 AND row_id=?3
				UNION ALL SELECT present, sequence FROM value_facts WHERE namespace=?1 AND local_key=?2 AND ?3='' LIMIT 1`,
			bind: (stmt, c) => stmt.get(c.namespace, c.localKey, c.rowId),
		};
	}
	return {
		sql: `SELECT f.present AS present, f.sequence AS sequence FROM row_facts f JOIN coordinates c USING(coordinate_id) WHERE c.kind=?1 AND c.namespace=?2 AND c.local_key=?3 AND f.row_id=?4
			UNION ALL SELECT f.present AS present, f.sequence AS sequence FROM value_facts f JOIN coordinates c USING(coordinate_id) WHERE c.kind=?1 AND c.namespace=?2 AND c.local_key=?3 AND ?4='' LIMIT 1`,
		bind: (stmt, c) => stmt.get(c.kind, c.namespace, c.localKey, c.rowId),
	};
}
