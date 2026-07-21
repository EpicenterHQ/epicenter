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
import type { Intent } from '../../../packages/data/src/protocol/v1/intents.js';
import type { AuxiliaryTraces, DocumentEntry } from './auxiliary-traces.js';
import type { Candidate } from './candidates.js';
import { Sha256Stream } from './portable-hash.js';
import type { Address, Fact, RowAddress, ValueAddress } from './trace.js';
import { canonicalFactRecord, utf8Len } from './trace.js';

export { CANDIDATES, type Candidate } from './candidates.js';

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
		// The coordinate kind decides the row_id shape: a row coordinate needs a
		// 24-char lowercase runtime id, a value coordinate needs the empty row_id.
		// This refuses a value fact carrying a non-empty row_id, which would sit
		// beside the '' row and let one value address hold multiple physical rows,
		// and refuses a row fact with a malformed id. The fact CHECK still enforces
		// payload/presence semantics by looking up the kind through the coordinate.
		const shapeExpr = `(
			(SELECT kind FROM coordinates WHERE coordinate_id = NEW.coordinate_id) = 'row'
				AND length(NEW.row_id) = 24 AND NEW.row_id NOT GLOB '*[^a-z0-9]*'
			OR (SELECT kind FROM coordinates WHERE coordinate_id = NEW.coordinate_id) = 'value'
				AND NEW.row_id = ''
		)`;
		const payloadExpr = `(
			CASE (SELECT kind FROM coordinates WHERE coordinate_id = NEW.coordinate_id)
				WHEN 'row' THEN
					CASE NEW.present WHEN 1 THEN json_valid(NEW.payload) = 1 AND json_type(NEW.payload) = 'object' ELSE NEW.payload IS NULL END
				WHEN 'value' THEN
					CASE NEW.present WHEN 1 THEN json_valid(NEW.payload) = 1 ELSE NEW.payload IS NULL END
				ELSE 0
			END
		)`;
		return `
			CREATE TABLE facts (
				coordinate_id INTEGER NOT NULL REFERENCES coordinates(coordinate_id),
				row_id TEXT NOT NULL,
				present INTEGER NOT NULL CHECK (present IN (0, 1)),
				payload TEXT,
				sequence INTEGER NOT NULL UNIQUE ${sequence},
				PRIMARY KEY (coordinate_id, row_id)
			) WITHOUT ROWID;
			CREATE TRIGGER facts_shape_insert BEFORE INSERT ON facts
			WHEN NOT (${shapeExpr} AND ${payloadExpr})
			BEGIN SELECT RAISE(ABORT, 'invalid unified normalized fact shape'); END;
			CREATE TRIGGER facts_shape_update BEFORE UPDATE ON facts
			WHEN NOT (${shapeExpr} AND ${payloadExpr})
			BEGIN SELECT RAISE(ABORT, 'invalid unified normalized fact shape'); END;
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
	// Under normalized coordinates each fact table may reference only its own kind:
	// row_facts a row coordinate, value_facts a value coordinate. Without this a
	// row_facts row could point at a value coordinate and reinterpret it.
	const kindTriggers =
		candidate.coordinates === 'normalized'
			? `
		CREATE TRIGGER row_facts_kind_insert BEFORE INSERT ON row_facts
		WHEN (SELECT kind FROM coordinates WHERE coordinate_id = NEW.coordinate_id) IS NOT 'row'
		BEGIN SELECT RAISE(ABORT, 'row_facts requires a row coordinate'); END;
		CREATE TRIGGER row_facts_kind_update BEFORE UPDATE OF coordinate_id ON row_facts
		WHEN (SELECT kind FROM coordinates WHERE coordinate_id = NEW.coordinate_id) IS NOT 'row'
		BEGIN SELECT RAISE(ABORT, 'row_facts requires a row coordinate'); END;
		CREATE TRIGGER value_facts_kind_insert BEFORE INSERT ON value_facts
		WHEN (SELECT kind FROM coordinates WHERE coordinate_id = NEW.coordinate_id) IS NOT 'value'
		BEGIN SELECT RAISE(ABORT, 'value_facts requires a value coordinate'); END;
		CREATE TRIGGER value_facts_kind_update BEFORE UPDATE OF coordinate_id ON value_facts
		WHEN (SELECT kind FROM coordinates WHERE coordinate_id = NEW.coordinate_id) IS NOT 'value'
		BEGIN SELECT RAISE(ABORT, 'value_facts requires a value coordinate'); END;`
			: '';
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
		${kindTriggers}
		${splitSequenceTriggers()}
	`;
}

/** Coordinate dictionary plus coordinate-aware auxiliary tables. */
function coordinateAndAuxiliaryDdl(candidate: Candidate): string {
	const normalized = candidate.coordinates === 'normalized';
	// Coordinates are an append-only immutable dictionary. Any UPDATE or DELETE is
	// refused, so an existing coordinate_id can never be reinterpreted (a value
	// coordinate turned into a row coordinate, a namespace swapped) and INSERT OR
	// REPLACE, which deletes then reinserts, is refused before it can reinterpret a
	// fact. Combined with the unique triple, coordinate identity is immutable.
	const coordinates = normalized
		? `CREATE TABLE coordinates (
			coordinate_id INTEGER PRIMARY KEY,
			kind TEXT NOT NULL CHECK (kind IN ('row', 'value')),
			namespace TEXT NOT NULL CHECK (typeof(namespace) = 'text' AND length(namespace) > 0),
			local_key TEXT NOT NULL CHECK (typeof(local_key) = 'text' AND length(local_key) > 0),
			UNIQUE (kind, namespace, local_key)
		);
		CREATE TRIGGER coordinates_immutable_update BEFORE UPDATE ON coordinates
		BEGIN SELECT RAISE(ABORT, 'coordinates are an immutable append-only dictionary'); END;
		CREATE TRIGGER coordinates_immutable_delete BEFORE DELETE ON coordinates
		BEGIN SELECT RAISE(ABORT, 'coordinates are an immutable append-only dictionary'); END;`
		: '';
	// Address columns are inline or a coordinate reference, so the auxiliary tables
	// honor the same coordinate decision as the confirmed facts.
	const addr = normalized
		? 'coordinate_id INTEGER NOT NULL REFERENCES coordinates(coordinate_id), row_id TEXT NOT NULL'
		: 'kind TEXT NOT NULL, namespace TEXT NOT NULL, local_key TEXT NOT NULL, row_id TEXT NOT NULL';
	const addrPk = normalized
		? '(coordinate_id, row_id)'
		: '(kind, namespace, local_key, row_id)';
	const addrPkColumns = normalized
		? 'coordinate_id, row_id'
		: 'kind, namespace, local_key, row_id';
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
		CREATE TABLE sealed_submissions (
			${addr},
			submission_number INTEGER NOT NULL,
			present INTEGER NOT NULL CHECK (present IN (0, 1)),
			payload TEXT,
			PRIMARY KEY ${addrPk}
		) WITHOUT ROWID;
		CREATE TABLE retry_ledger (
			replica_id TEXT NOT NULL PRIMARY KEY,
			last_submission INTEGER NOT NULL,
			request_hash TEXT NOT NULL
		) WITHOUT ROWID;
		CREATE TABLE retry_parked (
			replica_id TEXT NOT NULL,
			${addr},
			code TEXT NOT NULL,
			measured_bytes INTEGER NOT NULL,
			limit_bytes INTEGER NOT NULL,
			PRIMARY KEY (replica_id, ${addrPkColumns})
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
	// REPLACE fires BEFORE DELETE triggers only when recursive triggers are on, so
	// this is load-bearing: it lets the coordinate-immutability delete trigger catch
	// an INSERT OR REPLACE that would otherwise silently reinterpret a coordinate.
	database.exec('PRAGMA recursive_triggers=ON');
	database.exec('PRAGMA journal_mode=WAL');
	database.exec('PRAGMA synchronous=NORMAL');
	database.exec('PRAGMA temp_store=MEMORY');
}

export function configureReopenedDatabase(database: Database): void {
	database.exec(`PRAGMA cache_size=-${CACHE_KIB}`);
	database.exec('PRAGMA foreign_keys=ON');
	database.exec('PRAGMA recursive_triggers=ON');
	database.exec('PRAGMA synchronous=NORMAL');
	database.exec('PRAGMA temp_store=MEMORY');
}

// --- Store -------------------------------------------------------------------

export type OracleWitness = { count: number; bytes: number; digestHex: string };

export type LayoutStore = {
	installFacts(facts: Iterable<Fact>): void;
	/** Populate the replica-owned auxiliary tables: pending, sealed, parked, documents. */
	populateReplicaAuxiliary(aux: AuxiliaryTraces): void;
	/** Populate the authority-owned auxiliary tables: retry ledger, retry parked, documents. */
	populateAuthorityAuxiliary(aux: AuxiliaryTraces): void;
	/** Reproduce the analytical oracle witness by scanning ORDER BY sequence. */
	scanWitness(): OracleWitness;
	/** Read one current fact's presence and sequence, or null. */
	pointRead(address: Address): { present: 0 | 1; sequence: number } | null;
	/** Ordered traversal of one sequence-bounded page of current facts. */
	traverse(afterSequence: number, throughSequence: number): number;
	/** Read the confirmed fact plus any replica pending-intent overlay for an address. */
	overlayRead(address: Address): { confirmed: 0 | 1; pending: 0 | 1 };
	/** Authority resume feed: rows with sequence greater than a watermark, ordered. */
	resumeFeed(afterSequence: number, limit: number): number;
	/** Authority exact-retry settlement read: the replica's ledger and parked count. */
	retrySettlementRead(replicaId: string): { found: 0 | 1; parked: number };
	/** Monotonic install of one fact (higher sequence wins, tombstone-dominant). */
	installMonotonic(fact: Fact): void;
	/**
	 * Row tombstone plus document cleanup in one transaction: install a terminal
	 * absent row fact and remove that row's document bytes together.
	 */
	deleteRowWithDocument(address: RowAddress, sequence: number): void;
	/**
	 * Authority submission settlement: fold each intent into a confirmed fact at a
	 * fresh monotonic sequence and record the replica retry ledger, in one
	 * transaction. Returns the next free sequence.
	 */
	settleSubmission(
		replicaId: string,
		intents: readonly Fact[],
		baseSequence: number,
		requestHash: string,
	): number;
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
	const sealedStmt = normalized
		? prepare(
				'INSERT OR REPLACE INTO sealed_submissions (coordinate_id, row_id, submission_number, present, payload) VALUES (?, ?, ?, ?, ?)',
			)
		: prepare(
				'INSERT OR REPLACE INTO sealed_submissions (kind, namespace, local_key, row_id, submission_number, present, payload) VALUES (?, ?, ?, ?, ?, ?, ?)',
			);
	const retryParkedStmt = normalized
		? prepare(
				'INSERT OR REPLACE INTO retry_parked (replica_id, coordinate_id, row_id, code, measured_bytes, limit_bytes) VALUES (?, ?, ?, ?, ?, ?)',
			)
		: prepare(
				'INSERT OR REPLACE INTO retry_parked (replica_id, kind, namespace, local_key, row_id, code, measured_bytes, limit_bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
			);
	const documentDeleteStmt = normalized
		? prepare(
				'DELETE FROM row_documents WHERE coordinate_id = ? AND row_id = ?',
			)
		: prepare(
				'DELETE FROM row_documents WHERE namespace = ? AND table_key = ? AND row_id = ?',
			);
	const overlayPendingStmt = normalized
		? prepare(
				'SELECT present FROM pending_intents WHERE coordinate_id = ? AND row_id = ?',
			)
		: prepare(
				'SELECT present FROM pending_intents WHERE kind = ? AND namespace = ? AND local_key = ? AND row_id = ?',
			);
	const resumeFeedStmt = ((): ReturnType<typeof prepare> => {
		if (candidate.relation === 'unified') {
			return prepare(
				'SELECT sequence FROM facts WHERE sequence > ? ORDER BY sequence LIMIT ?',
			);
		}
		return prepare(
			`SELECT sequence FROM (
				SELECT sequence FROM row_facts WHERE sequence > ?1
				UNION ALL SELECT sequence FROM value_facts WHERE sequence > ?1
			) ORDER BY sequence LIMIT ?2`,
		);
	})();
	const retryLedgerReadStmt = prepare(
		'SELECT last_submission FROM retry_ledger WHERE replica_id = ?',
	);
	const retryParkedCountStmt = prepare(
		'SELECT COUNT(*) AS n FROM retry_parked WHERE replica_id = ?',
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

	function intentColumns(intent: Intent): {
		present: 0 | 1;
		payload: string | null;
	} {
		if (intent.presence !== 'present') return { present: 0, payload: null };
		return {
			present: 1,
			payload:
				'set' in intent
					? canonicalize(intent.set)
					: canonicalize(intent.content),
		};
	}

	function insertSealed(intent: Intent, submissionNumber: number): void {
		const { present, payload } = intentColumns(intent);
		insertPendingOrParked(sealedStmt, intent.address, [
			submissionNumber,
			present,
			payload,
		]);
	}

	function insertRetryParked(
		replicaId: string,
		address: Address,
		code: string,
		measured: number,
		limit: number,
	): void {
		const cols = addressColumns(address);
		const args: SQLQueryBindings[] = normalized
			? [
					replicaId,
					coordinateId(cols.kind, cols.namespace, cols.localKey),
					cols.rowId,
					code,
					measured,
					limit,
				]
			: [
					replicaId,
					cols.kind,
					cols.namespace,
					cols.localKey,
					cols.rowId,
					code,
					measured,
					limit,
				];
		retryParkedStmt.run(...args);
	}

	function deleteDocument(address: RowAddress): void {
		if (normalized) {
			documentDeleteStmt.run(
				coordinateId('row', address.namespace, address.table),
				address.rowId,
			);
		} else {
			documentDeleteStmt.run(address.namespace, address.table, address.rowId);
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
		populateReplicaAuxiliary(aux) {
			// The replica owns pending intents, one sealed submission, parked overlay,
			// and row documents.
			const run = database.transaction(() => {
				for (const intent of aux.pending.entries) {
					const { present, payload } = intentColumns(intent);
					insertPendingOrParked(pendingStmt, intent.address, [
						present,
						payload,
					]);
				}
				for (const submission of aux.sealed.entries) {
					for (const intent of submission.intents) {
						insertSealed(intent, submission.submissionNumber);
					}
				}
				for (const parked of aux.parked.entries) {
					insertPendingOrParked(parkedStmt, parked.address, [
						parked.code,
						parked.measuredBytes,
						parked.limitBytes,
					]);
				}
				for (const doc of aux.document.entries) insertDocument(doc);
			});
			run();
		},
		populateAuthorityAuxiliary(aux) {
			// The authority owns the per-replica retry ledger, its parked results, and
			// row documents (the confirmed facts are the facts table itself).
			const run = database.transaction(() => {
				for (const retry of aux.retry.entries) {
					retryStmt.run(
						retry.replicaId,
						retry.lastSubmissionNumber,
						retry.requestHashHex,
					);
					for (const parked of retry.parked) {
						insertRetryParked(
							retry.replicaId,
							parked.address,
							parked.code,
							parked.measuredBytes,
							parked.limitBytes,
						);
					}
				}
				for (const doc of aux.document.entries) insertDocument(doc);
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
		traverse(afterSequence, throughSequence) {
			if (
				!Number.isSafeInteger(afterSequence) ||
				afterSequence < 0 ||
				!Number.isSafeInteger(throughSequence) ||
				throughSequence <= afterSequence
			) {
				throw new Error(
					'traversal range must be increasing nonnegative integers',
				);
			}
			let count = 0;
			for (const _fact of pointStore.scanRange(
				afterSequence,
				throughSequence,
			)) {
				count += 1;
			}
			return count;
		},
		overlayRead(address) {
			const confirmed = pointStore.point(address);
			const cols = addressColumns(address);
			const pendingRow = (
				normalized
					? overlayPendingStmt.get(
							coordinateId(cols.kind, cols.namespace, cols.localKey),
							cols.rowId,
						)
					: overlayPendingStmt.get(
							cols.kind,
							cols.namespace,
							cols.localKey,
							cols.rowId,
						)
			) as { present: 0 | 1 } | null;
			return {
				confirmed: confirmed === null ? 0 : 1,
				pending: pendingRow === null ? 0 : 1,
			};
		},
		resumeFeed(afterSequence, limit) {
			return (resumeFeedStmt.all(afterSequence, limit) as unknown[]).length;
		},
		retrySettlementRead(replicaId) {
			const ledger = retryLedgerReadStmt.get(replicaId) as {
				last_submission: number;
			} | null;
			const parked = (retryParkedCountStmt.get(replicaId) as { n: number }).n;
			return { found: ledger === null ? 0 : 1, parked };
		},
		installMonotonic(fact) {
			installFact(factToRow(fact));
		},
		deleteRowWithDocument(address, sequence) {
			// One transaction: a terminal row tombstone plus its document bytes removal.
			const run = database.transaction(() => {
				installFact(factToRow({ address, sequence, presence: 'absent' }));
				deleteDocument(address);
			});
			run();
		},
		settleSubmission(replicaId, intents, baseSequence, requestHash) {
			// Fold each intent into a confirmed fact at a fresh monotonic sequence and
			// record the replica retry ledger, in one transaction (authority settlement).
			let sequence = baseSequence;
			const run = database.transaction(() => {
				for (const intent of intents) {
					installFact(factToRow({ ...intent, sequence } as Fact));
					sequence += 1;
				}
				retryStmt.run(replicaId, sequence - baseSequence, requestHash);
			});
			run();
			return sequence;
		},
		candidateTableBytes() {
			// Count every candidate-owned btree: the tables themselves AND all of
			// their indexes, including the sqlite_autoindex_* btrees SQLite creates for
			// PRIMARY KEY and UNIQUE constraints. `sqlite_schema.tbl_name` groups a
			// table with its own indexes and autoindexes, so joining dbstat through it
			// captures storage an earlier table-name-only filter silently omitted.
			const placeholders = CANDIDATE_TABLE_NAMES.map(() => '?').join(',');
			const rows = database
				.prepare(
					`SELECT COALESCE(SUM(pgsize), 0) AS bytes FROM dbstat
					 WHERE name IN (
						 SELECT name FROM sqlite_schema
						 WHERE type IN ('table', 'index') AND tbl_name IN (${placeholders})
					 )`,
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
	'sealed_submissions',
	'retry_ledger',
	'retry_parked',
];

// --- Statement builders ------------------------------------------------------

type Prepare = (sql: string) => ReturnType<Database['prepare']>;

type ResolveCoordinate = (
	kind: string,
	namespace: string,
	localKey: string,
) => number;

const UPDATE_SET =
	'present=excluded.present, payload=excluded.payload, sequence=excluded.sequence';

/**
 * A monotonic upsert tail: a conflicting write applies only when its sequence is
 * strictly higher, and a present intent never resurrects a terminal row tombstone
 * (a row whose current fact is absent). `rowTombstoneExpr` is a boolean SQL
 * expression true iff the EXISTING row is such a tombstone, or null for value
 * tables where absence is non-terminal. This makes install monotonic and
 * tombstone-dominant, so a lower sequence cannot overwrite a higher one and a
 * later present cannot revive a deleted row.
 */
function monotonicUpsert(
	conflictColumns: string,
	table: string,
	rowTombstoneExpr: string | null,
): string {
	const tombstone = rowTombstoneExpr
		? ` AND NOT (${rowTombstoneExpr} AND excluded.present = 1)`
		: '';
	return `ON CONFLICT(${conflictColumns}) DO UPDATE SET ${UPDATE_SET} WHERE excluded.sequence > ${table}.sequence${tombstone}`;
}

/** A confirmed-fact writer that hides all relation/coordinate/kind branching. */
function buildFactWriter(
	prepare: Prepare,
	candidate: Candidate,
): { run(row: Row, resolve: ResolveCoordinate): void } {
	if (candidate.relation === 'unified') {
		if (candidate.coordinates === 'inline') {
			const stmt = prepare(
				`INSERT INTO facts (kind, namespace, local_key, row_id, present, payload, sequence) VALUES (?, ?, ?, ?, ?, ?, ?) ${monotonicUpsert('kind, namespace, local_key, row_id', 'facts', "facts.kind = 'row' AND facts.present = 0")}`,
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
			`INSERT INTO facts (coordinate_id, row_id, present, payload, sequence) VALUES (?, ?, ?, ?, ?) ${monotonicUpsert('coordinate_id, row_id', 'facts', "(SELECT kind FROM coordinates WHERE coordinate_id = facts.coordinate_id) = 'row' AND facts.present = 0")}`,
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
			`INSERT INTO row_facts (namespace, local_key, row_id, present, payload, sequence) VALUES (?, ?, ?, ?, ?, ?) ${monotonicUpsert('namespace, local_key, row_id', 'row_facts', 'row_facts.present = 0')}`,
		);
		const valueStmt = prepare(
			`INSERT INTO value_facts (namespace, local_key, present, payload, sequence) VALUES (?, ?, ?, ?, ?) ${monotonicUpsert('namespace, local_key', 'value_facts', null)}`,
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
		`INSERT INTO row_facts (coordinate_id, row_id, present, payload, sequence) VALUES (?, ?, ?, ?, ?) ${monotonicUpsert('coordinate_id, row_id', 'row_facts', 'row_facts.present = 0')}`,
	);
	const valueStmt = prepare(
		`INSERT INTO value_facts (coordinate_id, present, payload, sequence) VALUES (?, ?, ?, ?) ${monotonicUpsert('coordinate_id', 'value_facts', null)}`,
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
	const scanRangeStmt = prepare(scanRangeSqlFor(candidate));
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
		*scanRange(
			afterSequence: number,
			throughSequence: number,
		): Generator<Fact> {
			for (const raw of scanRangeStmt.all(
				afterSequence,
				throughSequence,
			) as Array<Parameters<typeof reconstruct>[0]>) {
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

function scanRangeSqlFor(candidate: Candidate): string {
	if (candidate.relation === 'unified') {
		return candidate.coordinates === 'inline'
			? 'SELECT kind, namespace, local_key, row_id, present, payload, sequence FROM facts WHERE sequence > ?1 AND sequence <= ?2 ORDER BY sequence'
			: `SELECT c.kind AS kind, c.namespace AS namespace, c.local_key AS local_key, f.row_id AS row_id, f.present AS present, f.payload AS payload, f.sequence AS sequence
				FROM facts f JOIN coordinates c USING (coordinate_id)
				WHERE f.sequence > ?1 AND f.sequence <= ?2 ORDER BY f.sequence`;
	}
	if (candidate.coordinates === 'inline') {
		return `SELECT * FROM (
				SELECT 'row' AS kind, namespace, local_key, row_id, present, payload, sequence FROM row_facts WHERE sequence > ?1 AND sequence <= ?2
				UNION ALL
				SELECT 'value' AS kind, namespace, local_key, '' AS row_id, present, payload, sequence FROM value_facts WHERE sequence > ?1 AND sequence <= ?2
			) ORDER BY sequence`;
	}
	return `SELECT * FROM (
			SELECT c.kind AS kind, c.namespace AS namespace, c.local_key AS local_key, f.row_id AS row_id, f.present AS present, f.payload AS payload, f.sequence AS sequence
			FROM row_facts f JOIN coordinates c USING (coordinate_id)
			WHERE f.sequence > ?1 AND f.sequence <= ?2
			UNION ALL
			SELECT c.kind AS kind, c.namespace AS namespace, c.local_key AS local_key, '' AS row_id, f.present AS present, f.payload AS payload, f.sequence AS sequence
			FROM value_facts f JOIN coordinates c USING (coordinate_id)
			WHERE f.sequence > ?1 AND f.sequence <= ?2
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
