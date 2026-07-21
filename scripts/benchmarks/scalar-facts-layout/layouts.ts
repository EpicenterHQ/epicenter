/**
 * The four confirmed-facts layout candidates, their stores, and proofs.
 *
 * relation layout: one unified `facts` table, or split `row_facts`/`value_facts`.
 * coordinate layout: inline structured coordinates, or a normalized
 * `coordinates` dictionary keyed by `(kind, namespace, local_key)`.
 *
 * Every candidate keeps the SAME closed current-fact state under DDL, not just
 * under the store: presence/payload validity is two-valued (a present fact
 * requires a non-null valid payload; an absent fact requires SQL NULL), a
 * normalized fact table refuses a cross-kind coordinate, a row tombstone cannot
 * be resurrected by any write, and the global `UNIQUE(sequence)` is enforced. The
 * store performs the ADR-0163 monotonic install atomically (a nested transaction,
 * so a rejected normalized fact leaves no orphan coordinate) using INSERT for a new
 * address and UPDATE for a higher-sequence replacement, never an unconditional
 * upsert. Reads never invent content: a present fact with a null payload is
 * corruption, not an empty object. Point reads and the traverse and feed
 * operations execute the exact SQL their query plans explain. Storage is scoped
 * to the candidate-varying tables. This module owns no hashing: it yields plain
 * facts and the trace owns the digest, so no Bun crypto entangles layout logic.
 */
import type { SqliteDatabase } from '@epicenter/sqlite';

import { canonicalize } from '../../../packages/data/src/protocol/v1/canonical.js';
import type {
	Address,
	Fact,
	JsonObject,
	JsonValue,
	RowAddress,
	ValueAddress,
} from './trace.js';

export type Candidate = {
	id: string;
	relation: 'unified' | 'split';
	coordinates: 'inline' | 'normalized';
};

export const CANDIDATES: Candidate[] = [
	{ id: 'unified-inline', relation: 'unified', coordinates: 'inline' },
	{ id: 'unified-normalized', relation: 'unified', coordinates: 'normalized' },
	{ id: 'split-inline', relation: 'split', coordinates: 'inline' },
	{ id: 'split-normalized', relation: 'split', coordinates: 'normalized' },
];

export type InstallOutcome = 'installed' | 'ignored' | 'corruption';
export type PlanOp = 'feed' | 'rowPoint' | 'valuePoint' | 'traverse';

export type Store = {
	install(fact: Fact): InstallOutcome;
	get(address: Address): Fact | undefined;
	traverse(namespace: string, table: string): Fact[];
	feedPage(afterSequence: number, limit: number): Fact[];
	scanBySequence(): Iterable<Fact>;
	/** `EXPLAIN QUERY PLAN` of the exact SQL each op executes (split feed: both branches). */
	queryPlan(op: PlanOp): string;
	storageTables(): string[];
};

const ROW_ID_OK = (col: string) =>
	`typeof(${col}) = 'text' AND length(${col}) = 24 AND ${col} NOT GLOB '*[^a-z0-9]*'`;
const PRESENT_COL =
	"present INTEGER NOT NULL CHECK (typeof(present) = 'integer' AND present IN (0, 1))";
const SEQUENCE_COL =
	"sequence INTEGER NOT NULL UNIQUE CHECK (typeof(sequence) = 'integer' AND sequence >= 1 AND sequence <= 9007199254740991)";

/** Two-valued presence/payload validity for a known kind (NULL never passes). */
function inlinePayloadCheck(kind: 'row' | 'value'): string {
	const presentRule =
		kind === 'row'
			? "payload IS NOT NULL AND json_valid(payload) AND json_type(payload) = 'object'"
			: 'payload IS NOT NULL AND json_valid(payload)';
	return `CHECK (CASE WHEN present = 0 THEN payload IS NULL ELSE ${presentRule} END)`;
}

function coordinateDdlStatements(referencingTables: string[]): string[] {
	const referenced = referencingTables
		.map(
			(t) => `SELECT 1 FROM ${t} WHERE ${t}.coordinate_id = OLD.coordinate_id`,
		)
		.join(' UNION ALL ');
	return [
		`CREATE TABLE coordinates (
  coordinate_id INTEGER PRIMARY KEY CHECK (typeof(coordinate_id) = 'integer'),
  kind TEXT NOT NULL CHECK (kind IN ('row', 'value')),
  namespace TEXT NOT NULL CHECK (typeof(namespace) = 'text' AND length(namespace) > 0),
  local_key TEXT NOT NULL CHECK (typeof(local_key) = 'text' AND length(local_key) > 0),
  UNIQUE (kind, namespace, local_key)
);`,
		`CREATE TRIGGER coordinates_immutable_update BEFORE UPDATE ON coordinates
WHEN EXISTS (${referenced})
BEGIN SELECT RAISE(ABORT, 'coordinate identity is immutable once referenced'); END;`,
		`CREATE TRIGGER coordinates_immutable_delete BEFORE DELETE ON coordinates
WHEN EXISTS (${referenced})
BEGIN SELECT RAISE(ABORT, 'coordinate is referenced'); END;`,
	];
}

/**
 * BEFORE INSERT/UPDATE shape triggers over a normalized fact table. Enforces the
 * referenced coordinate kind (so a row table refuses a value coordinate and vice
 * versa), the per-kind row-id shape, and two-valued presence/payload validity.
 */
function normalizedShapeTriggerStatements(
	table: string,
	tableKind: 'row' | 'value' | 'mixed',
): string[] {
	const coordKind = `(SELECT kind FROM coordinates WHERE coordinate_id = NEW.coordinate_id)`;
	const kindExpr = tableKind === 'mixed' ? coordKind : `'${tableKind}'`;
	// Two-valued (EXISTS never returns NULL) so it enforces coordinate existence
	// and kind WITHOUT relying on PRAGMA foreign_keys: with FKs off, a missing
	// coordinate makes EXISTS 0, so the trigger still fires and refuses the orphan.
	const kindMatch =
		tableKind === 'mixed'
			? `EXISTS (SELECT 1 FROM coordinates c WHERE c.coordinate_id = NEW.coordinate_id)`
			: `EXISTS (SELECT 1 FROM coordinates c WHERE c.coordinate_id = NEW.coordinate_id AND c.kind = '${tableKind}')`;
	const rowIdRule =
		tableKind === 'value'
			? '1'
			: tableKind === 'row'
				? `(${ROW_ID_OK('NEW.row_id')})`
				: `(CASE WHEN ${coordKind} = 'row' THEN ${ROW_ID_OK('NEW.row_id')} ELSE NEW.row_id = '' END)`;
	const payloadRule = `(CASE WHEN NEW.present = 0 THEN NEW.payload IS NULL WHEN ${kindExpr} = 'row' THEN NEW.payload IS NOT NULL AND json_valid(NEW.payload) AND json_type(NEW.payload) = 'object' ELSE NEW.payload IS NOT NULL AND json_valid(NEW.payload) END)`;
	const body = `WHEN NOT (${kindMatch} AND ${rowIdRule} AND ${payloadRule})
BEGIN SELECT RAISE(ABORT, 'invalid normalized fact shape'); END;`;
	return [
		`CREATE TRIGGER ${table}_shape_insert BEFORE INSERT ON ${table} ${body}`,
		`CREATE TRIGGER ${table}_shape_update BEFORE UPDATE ON ${table} ${body}`,
	];
}

/**
 * A terminal row tombstone is immutable except for a legal higher-sequence absent
 * confirmation (same address, still absent). Refuse resurrection (present),
 * primary-key/address mutation, and deletion at the DDL level, so no raw write can
 * free the address for reinsertion. `rowCond` identifies a row; `addressChanged`
 * is true when any address/PK column would change.
 */
function rowTombstoneTriggers(
	table: string,
	rowCond: string,
	addressChanged: string,
): string[] {
	const tomb = `${rowCond} AND OLD.present = 0`;
	return [
		`CREATE TRIGGER ${table}_tomb_no_resurrect BEFORE UPDATE ON ${table}
WHEN ${tomb} AND NEW.present = 1
BEGIN SELECT RAISE(ABORT, 'row tombstone is terminal'); END;`,
		`CREATE TRIGGER ${table}_tomb_no_move BEFORE UPDATE ON ${table}
WHEN ${tomb} AND (${addressChanged})
BEGIN SELECT RAISE(ABORT, 'row tombstone address is immutable'); END;`,
		`CREATE TRIGGER ${table}_tomb_no_delete BEFORE DELETE ON ${table}
WHEN ${rowCond} AND OLD.present = 0
BEGIN SELECT RAISE(ABORT, 'row tombstone cannot be deleted'); END;`,
	];
}

const SPLIT_SEQUENCE_TRIGGER_STATEMENTS = [
	`CREATE TRIGGER row_seq_insert BEFORE INSERT ON row_facts
WHEN EXISTS (SELECT 1 FROM value_facts WHERE value_facts.sequence = NEW.sequence)
BEGIN SELECT RAISE(ABORT, 'sequence collides across split tables'); END;`,
	`CREATE TRIGGER value_seq_insert BEFORE INSERT ON value_facts
WHEN EXISTS (SELECT 1 FROM row_facts WHERE row_facts.sequence = NEW.sequence)
BEGIN SELECT RAISE(ABORT, 'sequence collides across split tables'); END;`,
	`CREATE TRIGGER row_seq_update BEFORE UPDATE ON row_facts
WHEN EXISTS (SELECT 1 FROM value_facts WHERE value_facts.sequence = NEW.sequence)
BEGIN SELECT RAISE(ABORT, 'sequence collides across split tables'); END;`,
	`CREATE TRIGGER value_seq_update BEFORE UPDATE ON value_facts
WHEN EXISTS (SELECT 1 FROM row_facts WHERE row_facts.sequence = NEW.sequence)
BEGIN SELECT RAISE(ABORT, 'sequence collides across split tables'); END;`,
];

export function ddlStatements(candidate: Candidate): string[] {
	const unified = candidate.relation === 'unified';
	const normalized = candidate.coordinates === 'normalized';

	if (unified && !normalized) {
		return [
			`CREATE TABLE facts (
  kind TEXT NOT NULL CHECK (kind IN ('row', 'value')),
  namespace TEXT NOT NULL CHECK (typeof(namespace) = 'text' AND length(namespace) > 0),
  local_key TEXT NOT NULL CHECK (typeof(local_key) = 'text' AND length(local_key) > 0),
  row_id TEXT NOT NULL,
  ${PRESENT_COL},
  payload TEXT,
  ${SEQUENCE_COL},
  CHECK (CASE kind WHEN 'row' THEN ${ROW_ID_OK('row_id')} WHEN 'value' THEN row_id = '' ELSE 0 END),
  CHECK (CASE WHEN present = 0 THEN payload IS NULL WHEN kind = 'row' THEN payload IS NOT NULL AND json_valid(payload) AND json_type(payload) = 'object' ELSE payload IS NOT NULL AND json_valid(payload) END),
  PRIMARY KEY (kind, namespace, local_key, row_id)
) WITHOUT ROWID;`,
			...rowTombstoneTriggers(
				'facts',
				"OLD.kind = 'row'",
				'NEW.kind <> OLD.kind OR NEW.namespace <> OLD.namespace OR NEW.local_key <> OLD.local_key OR NEW.row_id <> OLD.row_id',
			),
		];
	}

	if (unified && normalized) {
		return [
			...coordinateDdlStatements(['facts']),
			`CREATE TABLE facts (
  coordinate_id INTEGER NOT NULL REFERENCES coordinates(coordinate_id),
  row_id TEXT NOT NULL,
  ${PRESENT_COL},
  payload TEXT,
  ${SEQUENCE_COL},
  PRIMARY KEY (coordinate_id, row_id)
) WITHOUT ROWID;`,
			...normalizedShapeTriggerStatements('facts', 'mixed'),
			...rowTombstoneTriggers(
				'facts',
				"(SELECT kind FROM coordinates WHERE coordinate_id = OLD.coordinate_id) = 'row'",
				'NEW.coordinate_id <> OLD.coordinate_id OR NEW.row_id <> OLD.row_id',
			),
		];
	}

	if (!normalized) {
		return [
			`CREATE TABLE row_facts (
  namespace TEXT NOT NULL CHECK (typeof(namespace) = 'text' AND length(namespace) > 0),
  local_key TEXT NOT NULL CHECK (typeof(local_key) = 'text' AND length(local_key) > 0),
  row_id TEXT NOT NULL CHECK (${ROW_ID_OK('row_id')}),
  ${PRESENT_COL},
  payload TEXT,
  ${SEQUENCE_COL},
  ${inlinePayloadCheck('row')},
  PRIMARY KEY (namespace, local_key, row_id)
) WITHOUT ROWID;`,
			`CREATE TABLE value_facts (
  namespace TEXT NOT NULL CHECK (typeof(namespace) = 'text' AND length(namespace) > 0),
  local_key TEXT NOT NULL CHECK (typeof(local_key) = 'text' AND length(local_key) > 0),
  ${PRESENT_COL},
  payload TEXT,
  ${SEQUENCE_COL},
  ${inlinePayloadCheck('value')},
  PRIMARY KEY (namespace, local_key)
) WITHOUT ROWID;`,
			...rowTombstoneTriggers(
				'row_facts',
				'1',
				'NEW.namespace <> OLD.namespace OR NEW.local_key <> OLD.local_key OR NEW.row_id <> OLD.row_id',
			),
			...SPLIT_SEQUENCE_TRIGGER_STATEMENTS,
		];
	}

	return [
		...coordinateDdlStatements(['row_facts', 'value_facts']),
		`CREATE TABLE row_facts (
  coordinate_id INTEGER NOT NULL REFERENCES coordinates(coordinate_id),
  row_id TEXT NOT NULL,
  ${PRESENT_COL},
  payload TEXT,
  ${SEQUENCE_COL},
  PRIMARY KEY (coordinate_id, row_id)
) WITHOUT ROWID;`,
		`CREATE TABLE value_facts (
  coordinate_id INTEGER NOT NULL REFERENCES coordinates(coordinate_id),
  ${PRESENT_COL},
  payload TEXT,
  ${SEQUENCE_COL},
  PRIMARY KEY (coordinate_id)
) WITHOUT ROWID;`,
		...normalizedShapeTriggerStatements('row_facts', 'row'),
		...normalizedShapeTriggerStatements('value_facts', 'value'),
		...rowTombstoneTriggers(
			'row_facts',
			'1',
			'NEW.coordinate_id <> OLD.coordinate_id OR NEW.row_id <> OLD.row_id',
		),
		...SPLIT_SEQUENCE_TRIGGER_STATEMENTS,
	];
}

function localKeyOf(address: Address): string {
	return address.kind === 'row' ? address.table : address.value;
}
function rowIdOf(address: Address): string {
	return address.kind === 'row' ? address.rowId : '';
}
function payloadTextOf(fact: Fact): string | null {
	if (fact.presence === 'absent') return null;
	// A present value carrying JSON null encodes as the text "null", never SQL NULL.
	return 'fields' in fact
		? canonicalize(fact.fields)
		: canonicalize(fact.content);
}
function requirePayload(payload: string | null): string {
	if (payload === null)
		throw new Error('present fact has a null payload (corruption)');
	return payload;
}

type Row = {
	kind: 'row' | 'value';
	namespace: string;
	local_key: string;
	row_id: string;
	present: number;
	payload: string | null;
	sequence: number;
};

function rowToFact(row: Row): Fact {
	if (row.kind === 'row') {
		const address: RowAddress = {
			kind: 'row',
			namespace: row.namespace,
			table: row.local_key,
			rowId: row.row_id,
		};
		return row.present === 1
			? {
					address,
					sequence: row.sequence,
					presence: 'present',
					fields: JSON.parse(requirePayload(row.payload)) as JsonObject,
				}
			: { address, sequence: row.sequence, presence: 'absent' };
	}
	const address: ValueAddress = {
		kind: 'value',
		namespace: row.namespace,
		value: row.local_key,
	};
	return row.present === 1
		? {
				address,
				sequence: row.sequence,
				presence: 'present',
				content: JSON.parse(requirePayload(row.payload)) as JsonValue,
			}
		: { address, sequence: row.sequence, presence: 'absent' };
}

function identityOf(fact: Fact): string {
	return `${fact.address.kind}|${fact.address.namespace}|${localKeyOf(fact.address)}|${rowIdOf(fact.address)}|${fact.sequence}|${fact.presence}|${payloadTextOf(fact) ?? ''}`;
}

function selectAll(
	table: string,
	kind: 'row' | 'value' | null,
	normalized: boolean,
): string {
	if (normalized) {
		const kindExpr = kind ? `'${kind}'` : 'c.kind';
		const rowIdExpr = kind === 'value' ? "''" : 't.row_id';
		return `SELECT ${kindExpr} AS kind, c.namespace AS namespace, c.local_key AS local_key, ${rowIdExpr} AS row_id, t.present AS present, t.payload AS payload, t.sequence AS sequence FROM ${table} t JOIN coordinates c ON c.coordinate_id = t.coordinate_id`;
	}
	const kindExpr = kind ? `'${kind}'` : 'kind';
	const rowIdExpr = kind === 'value' ? "''" : 'row_id';
	return `SELECT ${kindExpr} AS kind, namespace, local_key, ${rowIdExpr} AS row_id, present, payload, sequence FROM ${table}`;
}

export function createStore(db: SqliteDatabase, candidate: Candidate): Store {
	const normalized = candidate.coordinates === 'normalized';
	const split = candidate.relation === 'split';

	// Point reads: one statement per kind, so execution == the explained plan.
	function pointSqlFor(kind: 'row' | 'value'): string {
		if (normalized) {
			const table = split
				? kind === 'row'
					? 'row_facts'
					: 'value_facts'
				: 'facts';
			const coord = `(SELECT coordinate_id FROM coordinates WHERE kind = ? AND namespace = ? AND local_key = ?)`;
			return kind === 'value' && split
				? `SELECT present, payload, sequence FROM value_facts WHERE coordinate_id = ${coord}`
				: `SELECT present, payload, sequence FROM ${table} WHERE coordinate_id = ${coord} AND row_id = ?`;
		}
		if (!split)
			return 'SELECT present, payload, sequence FROM facts WHERE kind = ? AND namespace = ? AND local_key = ? AND row_id = ?';
		return kind === 'row'
			? 'SELECT present, payload, sequence FROM row_facts WHERE namespace = ? AND local_key = ? AND row_id = ?'
			: 'SELECT present, payload, sequence FROM value_facts WHERE namespace = ? AND local_key = ?';
	}
	function pointParams(address: Address): (string | number)[] {
		const valueSplit = split && address.kind === 'value';
		if (normalized) {
			return valueSplit
				? [address.kind, address.namespace, localKeyOf(address)]
				: [
						address.kind,
						address.namespace,
						localKeyOf(address),
						rowIdOf(address),
					];
		}
		if (!split)
			return [
				address.kind,
				address.namespace,
				localKeyOf(address),
				rowIdOf(address),
			];
		return address.kind === 'row'
			? [address.namespace, address.table, address.rowId]
			: [address.namespace, address.value];
	}

	function selectRow(address: Address): Row | undefined {
		const raw = db.all<{
			present: number;
			payload: string | null;
			sequence: number;
		}>(pointSqlFor(address.kind), pointParams(address))[0];
		if (!raw) return undefined;
		return {
			kind: address.kind,
			namespace: address.namespace,
			local_key: localKeyOf(address),
			row_id: rowIdOf(address),
			present: raw.present,
			payload: raw.payload,
			sequence: raw.sequence,
		};
	}

	function ensureCoordinate(address: Address): number {
		db.run(
			'INSERT OR IGNORE INTO coordinates (kind, namespace, local_key) VALUES (?, ?, ?)',
			[address.kind, address.namespace, localKeyOf(address)],
		);
		const found = db.all<{ coordinate_id: number }>(
			'SELECT coordinate_id FROM coordinates WHERE kind = ? AND namespace = ? AND local_key = ?',
			[address.kind, address.namespace, localKeyOf(address)],
		)[0];
		if (!found) throw new Error('coordinate not found after insert');
		return found.coordinate_id;
	}

	function writeFact(fact: Fact, mode: 'insert' | 'update'): void {
		const address = fact.address;
		const present = fact.presence === 'present' ? 1 : 0;
		const payload = payloadTextOf(fact);
		if (normalized) {
			const cid = ensureCoordinate(address);
			if (split && address.kind === 'value') {
				if (mode === 'insert')
					db.run(
						'INSERT INTO value_facts (coordinate_id, present, payload, sequence) VALUES (?, ?, ?, ?)',
						[cid, present, payload, fact.sequence],
					);
				else
					db.run(
						'UPDATE value_facts SET present = ?, payload = ?, sequence = ? WHERE coordinate_id = ?',
						[present, payload, fact.sequence, cid],
					);
			} else {
				const table = split ? 'row_facts' : 'facts';
				if (mode === 'insert')
					db.run(
						`INSERT INTO ${table} (coordinate_id, row_id, present, payload, sequence) VALUES (?, ?, ?, ?, ?)`,
						[cid, rowIdOf(address), present, payload, fact.sequence],
					);
				else
					db.run(
						`UPDATE ${table} SET present = ?, payload = ?, sequence = ? WHERE coordinate_id = ? AND row_id = ?`,
						[present, payload, fact.sequence, cid, rowIdOf(address)],
					);
			}
			return;
		}
		if (!split) {
			if (mode === 'insert')
				db.run(
					'INSERT INTO facts (kind, namespace, local_key, row_id, present, payload, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)',
					[
						address.kind,
						address.namespace,
						localKeyOf(address),
						rowIdOf(address),
						present,
						payload,
						fact.sequence,
					],
				);
			else
				db.run(
					'UPDATE facts SET present = ?, payload = ?, sequence = ? WHERE kind = ? AND namespace = ? AND local_key = ? AND row_id = ?',
					[
						present,
						payload,
						fact.sequence,
						address.kind,
						address.namespace,
						localKeyOf(address),
						rowIdOf(address),
					],
				);
			return;
		}
		if (address.kind === 'row') {
			if (mode === 'insert')
				db.run(
					'INSERT INTO row_facts (namespace, local_key, row_id, present, payload, sequence) VALUES (?, ?, ?, ?, ?, ?)',
					[
						address.namespace,
						address.table,
						address.rowId,
						present,
						payload,
						fact.sequence,
					],
				);
			else
				db.run(
					'UPDATE row_facts SET present = ?, payload = ?, sequence = ? WHERE namespace = ? AND local_key = ? AND row_id = ?',
					[
						present,
						payload,
						fact.sequence,
						address.namespace,
						address.table,
						address.rowId,
					],
				);
			return;
		}
		if (mode === 'insert')
			db.run(
				'INSERT INTO value_facts (namespace, local_key, present, payload, sequence) VALUES (?, ?, ?, ?, ?)',
				[address.namespace, address.value, present, payload, fact.sequence],
			);
		else
			db.run(
				'UPDATE value_facts SET present = ?, payload = ?, sequence = ? WHERE namespace = ? AND local_key = ?',
				[present, payload, fact.sequence, address.namespace, address.value],
			);
	}

	/**
	 * The whole state transition (read current, compare, write) is ONE transaction,
	 * so no interleaved write can slip between the read and the write and be
	 * overwritten by a stale-sequence install. The immediate write lock also rolls
	 * back any coordinate a rejected normalized fact created.
	 */
	function install(fact: Fact): InstallOutcome {
		return db.transaction((): InstallOutcome => {
			const prior = selectRow(fact.address);
			if (prior === undefined) {
				writeFact(fact, 'insert');
				return 'installed';
			}
			if (fact.sequence < prior.sequence) return 'ignored';
			if (fact.sequence === prior.sequence) {
				return identityOf(fact) === identityOf(rowToFact(prior))
					? 'ignored'
					: 'corruption';
			}
			if (
				prior.kind === 'row' &&
				prior.present === 0 &&
				fact.presence === 'present'
			) {
				return 'corruption';
			}
			writeFact(fact, 'update');
			return 'installed';
		});
	}

	const unifiedFeedSql = `${selectAll('facts', null, normalized)} WHERE sequence > ? ORDER BY sequence LIMIT ?`;
	const rowBranchSql = `${selectAll('row_facts', 'row', normalized)} WHERE sequence > ? ORDER BY sequence LIMIT ?`;
	const valueBranchSql = `${selectAll('value_facts', 'value', normalized)} WHERE sequence > ? ORDER BY sequence LIMIT ?`;
	function traverseSql(): string {
		if (normalized) {
			const table = split ? 'row_facts' : 'facts';
			return `SELECT 'row' AS kind, c.namespace AS namespace, c.local_key AS local_key, t.row_id AS row_id, t.present AS present, t.payload AS payload, t.sequence AS sequence FROM ${table} t JOIN coordinates c ON c.coordinate_id = t.coordinate_id WHERE c.kind = 'row' AND c.namespace = ? AND c.local_key = ? ORDER BY t.row_id`;
		}
		if (split)
			return `SELECT 'row' AS kind, namespace, local_key, row_id, present, payload, sequence FROM row_facts WHERE namespace = ? AND local_key = ? ORDER BY row_id`;
		return `SELECT kind, namespace, local_key, row_id, present, payload, sequence FROM facts WHERE kind = 'row' AND namespace = ? AND local_key = ? ORDER BY row_id`;
	}

	function mergeBranches(a: Row[], b: Row[], limit: number): Row[] {
		const out: Row[] = [];
		let i = 0;
		let j = 0;
		while (out.length < limit && (i < a.length || j < b.length)) {
			const ra = a[i];
			const rb = b[j];
			if (
				rb === undefined ||
				(ra !== undefined && ra.sequence <= rb.sequence)
			) {
				out.push(ra as Row);
				i += 1;
			} else {
				out.push(rb);
				j += 1;
			}
		}
		return out;
	}

	function feedPage(afterSequence: number, limit: number): Fact[] {
		if (!split)
			return db.all<Row>(unifiedFeedSql, [afterSequence, limit]).map(rowToFact);
		const rows = db.all<Row>(rowBranchSql, [afterSequence, limit]);
		const values = db.all<Row>(valueBranchSql, [afterSequence, limit]);
		return mergeBranches(rows, values, limit).map(rowToFact);
	}

	function* scanBySequence(): Generator<Fact> {
		const limit = 4096;
		let afterSequence = 0;
		while (true) {
			const page = feedPage(afterSequence, limit);
			yield* page;
			if (page.length < limit) return;
			afterSequence = page[page.length - 1]?.sequence ?? afterSequence;
		}
	}

	return {
		install,
		get: (address) => {
			const row = selectRow(address);
			return row ? rowToFact(row) : undefined;
		},
		traverse: (namespace, table) =>
			db.all<Row>(traverseSql(), [namespace, table]).map(rowToFact),
		feedPage,
		scanBySequence,
		queryPlan: (op) => {
			const explain = (sql: string) =>
				db
					.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`)
					.map((r) => r.detail)
					.join(' | ');
			if (op === 'feed') {
				if (!split) return explain(unifiedFeedSql);
				return `${explain(rowBranchSql)} || ${explain(valueBranchSql)} || + application merge`;
			}
			if (op === 'traverse') return explain(traverseSql());
			return explain(pointSqlFor(op === 'rowPoint' ? 'row' : 'value'));
		},
		storageTables: () =>
			split
				? normalized
					? ['coordinates', 'row_facts', 'value_facts']
					: ['row_facts', 'value_facts']
				: normalized
					? ['coordinates', 'facts']
					: ['facts'],
	};
}

// ---------------------------------------------------------------------------
// Proofs: real refusals per candidate, driven by raw SQL where the claim is a
// DDL-preserved invariant, not only through the Store reader.
// ---------------------------------------------------------------------------

export type MakeDb = (statements: string[]) => SqliteDatabase;

function fresh(candidate: Candidate, makeDb: MakeDb): SqliteDatabase {
	return makeDb(ddlStatements(candidate));
}

const ROW: RowAddress = {
	kind: 'row',
	namespace: 'so.epicenter.ns00',
	table: 'collection0001',
	rowId: '00000000000000000000000a',
};
const VAL: ValueAddress = {
	kind: 'value',
	namespace: 'so.epicenter.ns00',
	value: 'settingz',
};

function rejects(run: () => void): boolean {
	try {
		run();
		return false;
	} catch {
		return true;
	}
}

/** Raw INSERT of a present fact into the correct physical table, bypassing the store. */
function rawInsertPresent(
	db: SqliteDatabase,
	candidate: Candidate,
	address: Address,
	payload: string | null,
	sequence: number,
): void {
	const present = 1;
	if (candidate.coordinates === 'normalized') {
		db.run(
			'INSERT OR IGNORE INTO coordinates (kind, namespace, local_key) VALUES (?,?,?)',
			[address.kind, address.namespace, localKeyOf(address)],
		);
		const coordinate = db.all<{ id: number }>(
			'SELECT coordinate_id AS id FROM coordinates WHERE kind=? AND namespace=? AND local_key=?',
			[address.kind, address.namespace, localKeyOf(address)],
		)[0];
		if (!coordinate) throw new Error('coordinate not found after insert');
		const cid = coordinate.id;
		if (candidate.relation === 'split' && address.kind === 'value')
			db.run(
				'INSERT INTO value_facts (coordinate_id, present, payload, sequence) VALUES (?,?,?,?)',
				[cid, present, payload, sequence],
			);
		else
			db.run(
				`INSERT INTO ${candidate.relation === 'split' ? 'row_facts' : 'facts'} (coordinate_id, row_id, present, payload, sequence) VALUES (?,?,?,?,?)`,
				[cid, rowIdOf(address), present, payload, sequence],
			);
		return;
	}
	if (candidate.relation === 'unified')
		db.run(
			'INSERT INTO facts (kind, namespace, local_key, row_id, present, payload, sequence) VALUES (?,?,?,?,?,?,?)',
			[
				address.kind,
				address.namespace,
				localKeyOf(address),
				rowIdOf(address),
				present,
				payload,
				sequence,
			],
		);
	else if (address.kind === 'row')
		db.run(
			'INSERT INTO row_facts (namespace, local_key, row_id, present, payload, sequence) VALUES (?,?,?,?,?,?)',
			[
				address.namespace,
				address.table,
				address.rowId,
				present,
				payload,
				sequence,
			],
		);
	else
		db.run(
			'INSERT INTO value_facts (namespace, local_key, present, payload, sequence) VALUES (?,?,?,?,?)',
			[address.namespace, address.value, present, payload, sequence],
		);
}

function coordinateCount(db: SqliteDatabase): number {
	return (
		db.all<{ n: number }>('SELECT count(*) AS n FROM coordinates')[0]?.n ?? 0
	);
}

export function negativeConstraintProofs(
	candidate: Candidate,
	makeDb: MakeDb,
): string[] {
	const failures: string[] = [];
	const check = (name: string, ok: boolean): void => {
		if (!ok) failures.push(`${candidate.id}: ${name} was not rejected`);
	};

	// Short/invalid row id (via the store).
	{
		const db = fresh(candidate, makeDb);
		const store = createStore(db, candidate);
		check(
			'short row id',
			rejects(() =>
				store.install({
					address: { ...ROW, rowId: 'tooShort' },
					sequence: 1,
					presence: 'present',
					fields: {},
				}),
			),
		);
	}
	// Raw present-row payload that is a scalar, not an object.
	{
		const db = fresh(candidate, makeDb);
		check(
			'raw non-object row payload',
			rejects(() => rawInsertPresent(db, candidate, ROW, '123', 1)),
		);
	}
	// Raw present fact with a SQL NULL payload (row and value).
	{
		const db = fresh(candidate, makeDb);
		check(
			'raw present row NULL payload',
			rejects(() => rawInsertPresent(db, candidate, ROW, null, 1)),
		);
	}
	{
		const db = fresh(candidate, makeDb);
		check(
			'raw present value NULL payload',
			rejects(() => rawInsertPresent(db, candidate, VAL, null, 1)),
		);
	}
	// A present value carrying JSON null must be storable as the text 'null'.
	{
		const db = fresh(candidate, makeDb);
		const store = createStore(db, candidate);
		store.install({
			address: VAL,
			sequence: 1,
			presence: 'present',
			content: null,
		});
		const read = store.get(VAL);
		check(
			'value present null stored (not rejected)',
			read?.presence === 'present' &&
				'content' in read &&
				read.content === null,
		);
	}
	// Duplicate sequence within a table (INSERT).
	{
		const db = fresh(candidate, makeDb);
		const store = createStore(db, candidate);
		store.install({
			address: ROW,
			sequence: 5,
			presence: 'present',
			fields: { a: 1 },
		});
		check(
			'duplicate sequence insert',
			rejects(() =>
				store.install({
					address: { ...ROW, rowId: '00000000000000000000000b' },
					sequence: 5,
					presence: 'present',
					fields: { a: 1 },
				}),
			),
		);
	}
	if (candidate.relation === 'split') {
		// Cross-table sequence collision on INSERT.
		{
			const db = fresh(candidate, makeDb);
			const store = createStore(db, candidate);
			store.install({
				address: ROW,
				sequence: 7,
				presence: 'present',
				fields: { a: 1 },
			});
			check(
				'cross-table sequence collision (insert)',
				rejects(() =>
					store.install({
						address: VAL,
						sequence: 7,
						presence: 'present',
						content: 1,
					}),
				),
			);
		}
		// Cross-table sequence collision on UPDATE (raw, to a colliding sequence).
		{
			const db = fresh(candidate, makeDb);
			const store = createStore(db, candidate);
			store.install({
				address: ROW,
				sequence: 7,
				presence: 'present',
				fields: { a: 1 },
			});
			store.install({
				address: VAL,
				sequence: 8,
				presence: 'present',
				content: 1,
			});
			check(
				'cross-table sequence collision (update)',
				rejects(() => db.run('UPDATE value_facts SET sequence = 7')),
			);
		}
	}
	if (candidate.coordinates === 'normalized') {
		// Referenced coordinate immutability.
		{
			const db = fresh(candidate, makeDb);
			const store = createStore(db, candidate);
			store.install({
				address: ROW,
				sequence: 1,
				presence: 'present',
				fields: { a: 1 },
			});
			check(
				'coordinate mutation',
				rejects(() =>
					db.run("UPDATE coordinates SET namespace = 'so.epicenter.ns99'"),
				),
			);
			check(
				'coordinate delete',
				rejects(() => db.run('DELETE FROM coordinates')),
			);
		}
		// A fact table refuses a cross-kind coordinate (raw insert).
		{
			const db = fresh(candidate, makeDb);
			db.run(
				'INSERT INTO coordinates (kind, namespace, local_key) VALUES (?,?,?)',
				['value', VAL.namespace, VAL.value],
			);
			const coordinate = db.all<{ id: number }>(
				'SELECT coordinate_id AS id FROM coordinates',
			)[0];
			if (!coordinate) throw new Error('coordinate not found after insert');
			const cid = coordinate.id;
			const rowTable = candidate.relation === 'split' ? 'row_facts' : 'facts';
			check(
				'row table refuses a value coordinate',
				rejects(() =>
					db.run(
						`INSERT INTO ${rowTable} (coordinate_id, row_id, present, payload, sequence) VALUES (?,?,?,?,?)`,
						[cid, ROW.rowId, 1, '{}', 1],
					),
				),
			);
		}
		// Reverse cross-kind: value storage refuses a row coordinate.
		if (candidate.relation === 'split') {
			const db = fresh(candidate, makeDb);
			db.run(
				'INSERT INTO coordinates (kind, namespace, local_key) VALUES (?,?,?)',
				['row', ROW.namespace, ROW.table],
			);
			const coordinate = db.all<{ id: number }>(
				'SELECT coordinate_id AS id FROM coordinates',
			)[0];
			if (!coordinate) throw new Error('coordinate not found after insert');
			check(
				'value table refuses a row coordinate',
				rejects(() =>
					db.run(
						'INSERT INTO value_facts (coordinate_id, present, payload, sequence) VALUES (?,?,?,?)',
						[coordinate.id, 1, '1', 1],
					),
				),
			);
		}
		// Orphan fact refused even with foreign_keys OFF (self-enforcing existence).
		{
			const db = fresh(candidate, makeDb);
			db.run('PRAGMA foreign_keys = OFF;');
			const table = candidate.relation === 'split' ? 'row_facts' : 'facts';
			check(
				'orphan fact refused with foreign_keys off',
				rejects(() =>
					db.run(
						`INSERT INTO ${table} (coordinate_id, row_id, present, payload, sequence) VALUES (?,?,?,?,?)`,
						[999999, ROW.rowId, 1, '{}', 1],
					),
				),
			);
		}
		// Atomic install: a rejected fact leaves no orphan coordinate.
		{
			const db = fresh(candidate, makeDb);
			const store = createStore(db, candidate);
			const before = coordinateCount(db);
			rejects(() =>
				store.install({
					address: { ...ROW, rowId: 'bad' },
					sequence: 1,
					presence: 'present',
					fields: {},
				}),
			);
			check(
				'rejected fact leaves no orphan coordinate',
				coordinateCount(db) === before,
			);
		}
	}
	// Raw resurrection of a terminal row tombstone is refused.
	{
		const db = fresh(candidate, makeDb);
		const store = createStore(db, candidate);
		store.install({
			address: ROW,
			sequence: 1,
			presence: 'present',
			fields: { a: 1 },
		});
		store.install({ address: ROW, sequence: 2, presence: 'absent' });
		const table = candidate.relation === 'split' ? 'row_facts' : 'facts';
		check(
			'raw row tombstone resurrection',
			rejects(() =>
				db.run(`UPDATE ${table} SET present = 1, payload = '{}', sequence = 3`),
			),
		);
		check(
			'raw row tombstone delete',
			rejects(() => db.run(`DELETE FROM ${table}`)),
		);
		check(
			'raw row tombstone address mutation',
			rejects(() =>
				db.run(
					`UPDATE ${table} SET row_id = '00000000000000000000000z', sequence = 3`,
				),
			),
		);
	}
	return failures;
}

/** The monotonic install must exercise stale, equal-identical, equal-different, and resurrection. */
export function storeTransactionProofs(
	candidate: Candidate,
	makeDb: MakeDb,
): string[] {
	const failures: string[] = [];
	const db = fresh(candidate, makeDb);
	const store = createStore(db, candidate);
	const check = (name: string, ok: boolean): void => {
		if (!ok) failures.push(`${candidate.id}: ${name}`);
	};

	check(
		'initial install',
		store.install({
			address: ROW,
			sequence: 5,
			presence: 'present',
			fields: { n: 1 },
		}) === 'installed',
	);
	check(
		'higher replaces',
		store.install({
			address: ROW,
			sequence: 8,
			presence: 'present',
			fields: { n: 2 },
		}) === 'installed',
	);
	check(
		'stale ignored',
		store.install({
			address: ROW,
			sequence: 5,
			presence: 'present',
			fields: { n: 1 },
		}) === 'ignored',
	);
	check(
		'equal identical is a no-op',
		store.install({
			address: ROW,
			sequence: 8,
			presence: 'present',
			fields: { n: 2 },
		}) === 'ignored',
	);
	check(
		'equal different is corruption',
		store.install({
			address: ROW,
			sequence: 8,
			presence: 'present',
			fields: { n: 999 },
		}) === 'corruption',
	);
	const current = store.get(ROW);
	check(
		'current fact preserved after corruption refusal',
		current?.presence === 'present' &&
			'fields' in current &&
			current.fields.n === 2,
	);

	check(
		'tombstone installs',
		store.install({ address: ROW, sequence: 9, presence: 'absent' }) ===
			'installed',
	);
	check(
		'store refuses row resurrection',
		store.install({
			address: ROW,
			sequence: 10,
			presence: 'present',
			fields: { n: 3 },
		}) === 'corruption',
	);
	check('row stays tombstoned', store.get(ROW)?.presence === 'absent');

	// A value unset then resurrect is legal and must succeed.
	check(
		'value unset',
		store.install({ address: VAL, sequence: 11, presence: 'absent' }) ===
			'installed',
	);
	check(
		'value resurrect',
		store.install({
			address: VAL,
			sequence: 12,
			presence: 'present',
			content: 'again',
		}) === 'installed',
	);

	return failures;
}

export function layoutsSelfTest(makeDb: MakeDb): string[] {
	const failures: string[] = [];
	for (const candidate of CANDIDATES) {
		failures.push(...negativeConstraintProofs(candidate, makeDb));
		failures.push(...storeTransactionProofs(candidate, makeDb));
	}
	return failures;
}
