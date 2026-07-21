/**
 * The four confirmed-facts layout candidates, their stores, and proofs.
 *
 * relation layout: one unified `facts` table, or split `row_facts`/`value_facts`.
 * coordinate layout: inline structured coordinates, or a normalized
 * `coordinates` dictionary keyed by `(kind, namespace, local_key)`.
 *
 * Every candidate stores the same closed set of current facts and answers the
 * same operations, so only the physical layout differs. A store performs the
 * ADR-0163 monotonic install (higher replaces, lower ignored, equal identical or
 * corruption) plus a defensive terminal-row-tombstone guard, using INSERT for a
 * new address and UPDATE for a higher-sequence replacement so the global
 * `UNIQUE(sequence)` constraint is genuinely enforced, never an unconditional
 * upsert that would silently replace a colliding row. Storage is measured only
 * over the candidate-varying tables. This module owns no hashing: it yields plain
 * facts and the trace owns the digest, so no Bun crypto entangles layout logic.
 */
import { Database } from 'bun:sqlite';

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

export type Store = {
	install(fact: Fact): InstallOutcome;
	get(address: Address): Fact | undefined;
	traverse(namespace: string, table: string): Fact[];
	feedPage(afterSequence: number, limit: number): Fact[];
	/** Current facts in ascending sequence, for the ordered digest cross-check. */
	scanBySequence(): Fact[];
	/** `EXPLAIN QUERY PLAN` text for a named operation, for merge-only assertions. */
	queryPlan(op: 'feed' | 'rowPoint' | 'valuePoint'): string;
	/** The candidate-varying tables whose page bytes are the storage metric. */
	storageTables(): string[];
};

const ROW_ID_OK = (col: string) =>
	`typeof(${col}) = 'text' AND length(${col}) = 24 AND ${col} NOT GLOB '*[^a-z0-9]*'`;
const PRESENT_COL =
	"present INTEGER NOT NULL CHECK (typeof(present) = 'integer' AND present IN (0, 1))";
const SEQUENCE_COL =
	"sequence INTEGER NOT NULL UNIQUE CHECK (typeof(sequence) = 'integer' AND sequence >= 1 AND sequence <= 9007199254740991)";

/** Per-presence payload validity for a known kind. */
function inlinePayloadCheck(kindLiteral: "'row'" | "'value'"): string {
	const objectRule =
		kindLiteral === "'row'"
			? "json_valid(payload) AND json_type(payload) = 'object'"
			: 'json_valid(payload)';
	return `CHECK (CASE WHEN present = 0 THEN payload IS NULL ELSE ${objectRule} END)`;
}

function coordinatesDdl(referencingTables: string[]): string {
	const referenced = referencingTables
		.map(
			(t) => `SELECT 1 FROM ${t} WHERE ${t}.coordinate_id = OLD.coordinate_id`,
		)
		.join(' UNION ALL ');
	return `
CREATE TABLE coordinates (
  coordinate_id INTEGER PRIMARY KEY CHECK (typeof(coordinate_id) = 'integer'),
  kind TEXT NOT NULL CHECK (kind IN ('row', 'value')),
  namespace TEXT NOT NULL CHECK (typeof(namespace) = 'text' AND length(namespace) > 0),
  local_key TEXT NOT NULL CHECK (typeof(local_key) = 'text' AND length(local_key) > 0),
  UNIQUE (kind, namespace, local_key)
);
CREATE TRIGGER coordinates_immutable_update BEFORE UPDATE ON coordinates
WHEN EXISTS (${referenced})
BEGIN SELECT RAISE(ABORT, 'coordinate identity is immutable once referenced'); END;
CREATE TRIGGER coordinates_immutable_delete BEFORE DELETE ON coordinates
WHEN EXISTS (${referenced})
BEGIN SELECT RAISE(ABORT, 'coordinate is referenced'); END;`;
}

/** A BEFORE INSERT/UPDATE shape trigger over a normalized fact table. */
function normalizedShapeTriggers(
	table: string,
	fixedKind: 'row' | 'value' | null,
): string {
	const kindExpr = fixedKind
		? `'${fixedKind}'`
		: '(SELECT kind FROM coordinates WHERE coordinate_id = NEW.coordinate_id)';
	// A value_facts table has no row_id column, so it has no row-id rule.
	const rowIdRule =
		fixedKind === 'value'
			? '1'
			: `(CASE WHEN ${kindExpr} = 'row' THEN ${ROW_ID_OK('NEW.row_id')} WHEN ${kindExpr} = 'value' THEN NEW.row_id = '' ELSE 0 END)`;
	const payloadRule = `(CASE WHEN NEW.present = 0 THEN NEW.payload IS NULL WHEN ${kindExpr} = 'row' THEN json_valid(NEW.payload) AND json_type(NEW.payload) = 'object' ELSE json_valid(NEW.payload) END)`;
	const body = `WHEN NOT (${rowIdRule} AND ${payloadRule})
BEGIN SELECT RAISE(ABORT, 'invalid normalized fact shape'); END;`;
	return `
CREATE TRIGGER ${table}_shape_insert BEFORE INSERT ON ${table} ${body}
CREATE TRIGGER ${table}_shape_update BEFORE UPDATE ON ${table} ${body}`;
}

const SPLIT_SEQUENCE_TRIGGERS = `
CREATE TRIGGER row_seq_insert BEFORE INSERT ON row_facts
WHEN EXISTS (SELECT 1 FROM value_facts WHERE value_facts.sequence = NEW.sequence)
BEGIN SELECT RAISE(ABORT, 'sequence collides across split tables'); END;
CREATE TRIGGER value_seq_insert BEFORE INSERT ON value_facts
WHEN EXISTS (SELECT 1 FROM row_facts WHERE row_facts.sequence = NEW.sequence)
BEGIN SELECT RAISE(ABORT, 'sequence collides across split tables'); END;
CREATE TRIGGER row_seq_update BEFORE UPDATE ON row_facts
WHEN EXISTS (SELECT 1 FROM value_facts WHERE value_facts.sequence = NEW.sequence)
BEGIN SELECT RAISE(ABORT, 'sequence collides across split tables'); END;
CREATE TRIGGER value_seq_update BEFORE UPDATE ON value_facts
WHEN EXISTS (SELECT 1 FROM row_facts WHERE row_facts.sequence = NEW.sequence)
BEGIN SELECT RAISE(ABORT, 'sequence collides across split tables'); END;`;

export function ddlFor(candidate: Candidate): string {
	const unified = candidate.relation === 'unified';
	const normalized = candidate.coordinates === 'normalized';

	if (unified && !normalized) {
		return `
CREATE TABLE facts (
  kind TEXT NOT NULL CHECK (kind IN ('row', 'value')),
  namespace TEXT NOT NULL CHECK (typeof(namespace) = 'text' AND length(namespace) > 0),
  local_key TEXT NOT NULL CHECK (typeof(local_key) = 'text' AND length(local_key) > 0),
  row_id TEXT NOT NULL,
  ${PRESENT_COL},
  payload TEXT,
  ${SEQUENCE_COL},
  CHECK (CASE kind WHEN 'row' THEN ${ROW_ID_OK('row_id')} WHEN 'value' THEN row_id = '' ELSE 0 END),
  CHECK (CASE WHEN present = 0 THEN payload IS NULL WHEN kind = 'row' THEN json_valid(payload) AND json_type(payload) = 'object' ELSE json_valid(payload) END),
  PRIMARY KEY (kind, namespace, local_key, row_id)
) WITHOUT ROWID;`;
	}

	if (unified && normalized) {
		return `${coordinatesDdl(['facts'])}
CREATE TABLE facts (
  coordinate_id INTEGER NOT NULL REFERENCES coordinates(coordinate_id),
  row_id TEXT NOT NULL,
  ${PRESENT_COL},
  payload TEXT,
  ${SEQUENCE_COL},
  PRIMARY KEY (coordinate_id, row_id)
) WITHOUT ROWID;
${normalizedShapeTriggers('facts', null)}`;
	}

	if (!normalized) {
		return `
CREATE TABLE row_facts (
  namespace TEXT NOT NULL CHECK (typeof(namespace) = 'text' AND length(namespace) > 0),
  local_key TEXT NOT NULL CHECK (typeof(local_key) = 'text' AND length(local_key) > 0),
  row_id TEXT NOT NULL CHECK (${ROW_ID_OK('row_id')}),
  ${PRESENT_COL},
  payload TEXT,
  ${SEQUENCE_COL},
  ${inlinePayloadCheck("'row'")},
  PRIMARY KEY (namespace, local_key, row_id)
) WITHOUT ROWID;
CREATE TABLE value_facts (
  namespace TEXT NOT NULL CHECK (typeof(namespace) = 'text' AND length(namespace) > 0),
  local_key TEXT NOT NULL CHECK (typeof(local_key) = 'text' AND length(local_key) > 0),
  ${PRESENT_COL},
  payload TEXT,
  ${SEQUENCE_COL},
  ${inlinePayloadCheck("'value'")},
  PRIMARY KEY (namespace, local_key)
) WITHOUT ROWID;
${SPLIT_SEQUENCE_TRIGGERS}`;
	}

	return `${coordinatesDdl(['row_facts', 'value_facts'])}
CREATE TABLE row_facts (
  coordinate_id INTEGER NOT NULL REFERENCES coordinates(coordinate_id),
  row_id TEXT NOT NULL,
  ${PRESENT_COL},
  payload TEXT,
  ${SEQUENCE_COL},
  PRIMARY KEY (coordinate_id, row_id)
) WITHOUT ROWID;
CREATE TABLE value_facts (
  coordinate_id INTEGER NOT NULL REFERENCES coordinates(coordinate_id),
  ${PRESENT_COL},
  payload TEXT,
  ${SEQUENCE_COL},
  PRIMARY KEY (coordinate_id)
) WITHOUT ROWID;
${normalizedShapeTriggers('row_facts', 'row')}
${normalizedShapeTriggers('value_facts', 'value')}
${SPLIT_SEQUENCE_TRIGGERS}`;
}

function localKeyOf(address: Address): string {
	return address.kind === 'row' ? address.table : address.value;
}
function rowIdOf(address: Address): string {
	return address.kind === 'row' ? address.rowId : '';
}
function payloadTextOf(fact: Fact): string | null {
	if (fact.presence === 'absent') return null;
	return 'fields' in fact
		? canonicalize(fact.fields)
		: canonicalize(fact.content);
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
					fields: JSON.parse(row.payload ?? '{}') as JsonObject,
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
				content: JSON.parse(row.payload ?? 'null') as JsonValue,
			}
		: { address, sequence: row.sequence, presence: 'absent' };
}

/** A layout-independent identity for equal-content comparison (no hashing). */
function identityOf(fact: Fact): string {
	return `${fact.address.kind}|${fact.address.namespace}|${localKeyOf(fact.address)}|${rowIdOf(fact.address)}|${fact.sequence}|${fact.presence}|${payloadTextOf(fact) ?? ''}`;
}

/** The `SELECT` projecting one candidate's physical rows into the common Row shape. */
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

export function createStore(db: Database, candidate: Candidate): Store {
	const normalized = candidate.coordinates === 'normalized';
	const split = candidate.relation === 'split';

	const coordId = normalized
		? db.query<{ coordinate_id: number }, [string, string, string]>(
				'SELECT coordinate_id FROM coordinates WHERE kind = ? AND namespace = ? AND local_key = ?',
			)
		: null;

	function ensureCoordinate(address: Address): number {
		db.run(
			'INSERT OR IGNORE INTO coordinates (kind, namespace, local_key) VALUES (?, ?, ?)',
			[address.kind, address.namespace, localKeyOf(address)],
		);
		const found = coordId?.get(
			address.kind,
			address.namespace,
			localKeyOf(address),
		);
		if (!found) throw new Error('coordinate not found after insert');
		return found.coordinate_id;
	}

	function tableFor(address: Address): string {
		if (!split) return 'facts';
		return address.kind === 'row' ? 'row_facts' : 'value_facts';
	}

	function selectRow(address: Address): Row | undefined {
		const valueScoped = split && address.kind === 'value';
		if (normalized) {
			const found = coordId?.get(
				address.kind,
				address.namespace,
				localKeyOf(address),
			);
			if (!found) return undefined;
			const table = tableFor(address);
			const raw = valueScoped
				? (db
						.query(
							'SELECT present, payload, sequence FROM value_facts WHERE coordinate_id = ?',
						)
						.get(found.coordinate_id) as {
						present: number;
						payload: string | null;
						sequence: number;
					} | null)
				: (db
						.query(
							`SELECT present, payload, sequence FROM ${table} WHERE coordinate_id = ? AND row_id = ?`,
						)
						.get(found.coordinate_id, rowIdOf(address)) as {
						present: number;
						payload: string | null;
						sequence: number;
					} | null);
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
		if (!split) {
			const raw = db
				.query(
					'SELECT kind, namespace, local_key, row_id, present, payload, sequence FROM facts WHERE kind = ? AND namespace = ? AND local_key = ? AND row_id = ?',
				)
				.get(
					address.kind,
					address.namespace,
					localKeyOf(address),
					rowIdOf(address),
				) as Row | null;
			return raw ?? undefined;
		}
		if (address.kind === 'row') {
			const raw = db
				.query(
					'SELECT namespace, local_key, row_id, present, payload, sequence FROM row_facts WHERE namespace = ? AND local_key = ? AND row_id = ?',
				)
				.get(address.namespace, address.table, address.rowId) as Omit<
				Row,
				'kind'
			> | null;
			return raw ? { kind: 'row', ...raw } : undefined;
		}
		const raw = db
			.query(
				'SELECT namespace, local_key, present, payload, sequence FROM value_facts WHERE namespace = ? AND local_key = ?',
			)
			.get(address.namespace, address.value) as Omit<
			Row,
			'kind' | 'row_id'
		> | null;
		return raw ? { kind: 'value', row_id: '', ...raw } : undefined;
	}

	function insertRow(fact: Fact): void {
		const address = fact.address;
		const present = fact.presence === 'present' ? 1 : 0;
		const payload = payloadTextOf(fact);
		if (normalized) {
			const cid = ensureCoordinate(address);
			if (split && address.kind === 'value') {
				db.run(
					'INSERT INTO value_facts (coordinate_id, present, payload, sequence) VALUES (?, ?, ?, ?)',
					[cid, present, payload, fact.sequence],
				);
			} else {
				db.run(
					`INSERT INTO ${split ? 'row_facts' : 'facts'} (coordinate_id, row_id, present, payload, sequence) VALUES (?, ?, ?, ?, ?)`,
					[cid, rowIdOf(address), present, payload, fact.sequence],
				);
			}
			return;
		}
		if (!split) {
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
			return;
		}
		if (address.kind === 'row') {
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
			return;
		}
		db.run(
			'INSERT INTO value_facts (namespace, local_key, present, payload, sequence) VALUES (?, ?, ?, ?, ?)',
			[address.namespace, address.value, present, payload, fact.sequence],
		);
	}

	function updateRow(fact: Fact): void {
		const address = fact.address;
		const present = fact.presence === 'present' ? 1 : 0;
		const payload = payloadTextOf(fact);
		if (normalized) {
			const cid = ensureCoordinate(address);
			if (split && address.kind === 'value') {
				db.run(
					'UPDATE value_facts SET present = ?, payload = ?, sequence = ? WHERE coordinate_id = ?',
					[present, payload, fact.sequence, cid],
				);
			} else {
				db.run(
					`UPDATE ${split ? 'row_facts' : 'facts'} SET present = ?, payload = ?, sequence = ? WHERE coordinate_id = ? AND row_id = ?`,
					[present, payload, fact.sequence, cid, rowIdOf(address)],
				);
			}
			return;
		}
		if (!split) {
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
		db.run(
			'UPDATE value_facts SET present = ?, payload = ?, sequence = ? WHERE namespace = ? AND local_key = ?',
			[present, payload, fact.sequence, address.namespace, address.value],
		);
	}

	function install(fact: Fact): InstallOutcome {
		const prior = selectRow(fact.address);
		if (prior === undefined) {
			insertRow(fact);
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
			return 'corruption'; // a terminal row tombstone cannot be resurrected
		}
		updateRow(fact);
		return 'installed';
	}

	// Unified feeds from one sequence index. Split does an application-level merge
	// of two sequence-ordered index scans, so neither branch needs a temp b-tree.
	const unifiedFeedSql = `${selectAll('facts', null, normalized)} WHERE sequence > ? ORDER BY sequence LIMIT ?`;
	const rowBranchSql = `${selectAll('row_facts', 'row', normalized)} WHERE sequence > ? ORDER BY sequence LIMIT ?`;
	const valueBranchSql = `${selectAll('value_facts', 'value', normalized)} WHERE sequence > ? ORDER BY sequence LIMIT ?`;
	const unifiedScanSql = `${selectAll('facts', null, normalized)} ORDER BY sequence`;
	const rowScanSql = `${selectAll('row_facts', 'row', normalized)} ORDER BY sequence`;
	const valueScanSql = `${selectAll('value_facts', 'value', normalized)} ORDER BY sequence`;

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

	function pointSql(kind: 'row' | 'value'): string {
		if (normalized) {
			const table = split
				? kind === 'row'
					? 'row_facts'
					: 'value_facts'
				: 'facts';
			return kind === 'value' && split
				? `SELECT present, payload, sequence FROM value_facts WHERE coordinate_id = (SELECT coordinate_id FROM coordinates WHERE kind = 'value' AND namespace = ? AND local_key = ?)`
				: `SELECT present, payload, sequence FROM ${table} WHERE coordinate_id = (SELECT coordinate_id FROM coordinates WHERE kind = ? AND namespace = ? AND local_key = ?) AND row_id = ?`;
		}
		if (!split)
			return 'SELECT present, payload, sequence FROM facts WHERE kind = ? AND namespace = ? AND local_key = ? AND row_id = ?';
		return kind === 'row'
			? 'SELECT present, payload, sequence FROM row_facts WHERE namespace = ? AND local_key = ? AND row_id = ?'
			: 'SELECT present, payload, sequence FROM value_facts WHERE namespace = ? AND local_key = ?';
	}

	return {
		install,
		get: (address) => {
			const row = selectRow(address);
			return row ? rowToFact(row) : undefined;
		},
		traverse: (namespace, table) => {
			const source = split ? 'row_facts' : 'facts';
			const rows = db
				.query(`${selectAll(source, split ? 'row' : null, normalized)}`)
				.all() as Row[];
			return rows
				.filter(
					(r) =>
						r.kind === 'row' &&
						r.namespace === namespace &&
						r.local_key === table,
				)
				.sort((a, b) => a.row_id.localeCompare(b.row_id))
				.map(rowToFact);
		},
		feedPage: (afterSequence, limit) => {
			if (!split)
				return (
					db.query(unifiedFeedSql).all(afterSequence, limit) as Row[]
				).map(rowToFact);
			const rows = db.query(rowBranchSql).all(afterSequence, limit) as Row[];
			const vals = db.query(valueBranchSql).all(afterSequence, limit) as Row[];
			return mergeBranches(rows, vals, limit).map(rowToFact);
		},
		scanBySequence: () => {
			if (!split)
				return (db.query(unifiedScanSql).all() as Row[]).map(rowToFact);
			const rows = db.query(rowScanSql).all() as Row[];
			const vals = db.query(valueScanSql).all() as Row[];
			return mergeBranches(rows, vals, rows.length + vals.length).map(
				rowToFact,
			);
		},
		queryPlan: (op) => {
			const sql =
				op === 'feed'
					? split
						? rowBranchSql
						: unifiedFeedSql
					: pointSql(op === 'rowPoint' ? 'row' : 'value');
			const rows = db.query(`EXPLAIN QUERY PLAN ${sql}`).all() as {
				detail: string;
			}[];
			return rows.map((r) => r.detail).join(' | ');
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
// Proofs: real refusals per candidate, not a peer oracle.
// ---------------------------------------------------------------------------

function fresh(candidate: Candidate): Database {
	const db = new Database(':memory:');
	db.exec('PRAGMA foreign_keys = ON;');
	db.exec(ddlFor(candidate));
	return db;
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

/** Each DDL constraint must reject a violating write. */
export function negativeConstraintProofs(candidate: Candidate): string[] {
	const failures: string[] = [];
	const check = (name: string, ok: boolean): void => {
		if (!ok) failures.push(`${candidate.id}: ${name} was not rejected`);
	};

	// A short/invalid row id.
	{
		const db = fresh(candidate);
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
		db.close();
	}
	// A present-row payload that is not a JSON object.
	{
		const db = fresh(candidate);
		const store = createStore(db, candidate);
		// Install a valid present row, then attempt to corrupt via a raw scalar payload.
		check(
			'non-object row payload',
			rejects(() => {
				if (candidate.coordinates === 'normalized') {
					db.run(
						'INSERT INTO coordinates (kind, namespace, local_key) VALUES (?,?,?)',
						['row', ROW.namespace, ROW.table],
					);
					const cid = (
						db.query('SELECT coordinate_id AS id FROM coordinates').get() as {
							id: number;
						}
					).id;
					const table =
						candidate.relation === 'unified' ? 'facts' : 'row_facts';
					db.run(
						`INSERT INTO ${table} (coordinate_id, row_id, present, payload, sequence) VALUES (?,?,?,?,?)`,
						[cid, ROW.rowId, 1, '123', 1],
					);
				} else if (candidate.relation === 'unified') {
					db.run(
						'INSERT INTO facts (kind, namespace, local_key, row_id, present, payload, sequence) VALUES (?,?,?,?,?,?,?)',
						['row', ROW.namespace, ROW.table, ROW.rowId, 1, '123', 1],
					);
				} else {
					db.run(
						'INSERT INTO row_facts (namespace, local_key, row_id, present, payload, sequence) VALUES (?,?,?,?,?,?)',
						[ROW.namespace, ROW.table, ROW.rowId, 1, '123', 1],
					);
				}
				void store;
			}),
		);
		db.close();
	}
	// An absent fact with a non-null payload.
	{
		const db = fresh(candidate);
		check(
			'absent with payload',
			rejects(() => {
				if (candidate.coordinates === 'normalized') {
					db.run(
						'INSERT INTO coordinates (kind, namespace, local_key) VALUES (?,?,?)',
						['value', VAL.namespace, VAL.value],
					);
					const cid = (
						db.query('SELECT coordinate_id AS id FROM coordinates').get() as {
							id: number;
						}
					).id;
					if (candidate.relation === 'unified')
						db.run(
							'INSERT INTO facts (coordinate_id, row_id, present, payload, sequence) VALUES (?,?,?,?,?)',
							[cid, '', 0, '"x"', 1],
						);
					else
						db.run(
							'INSERT INTO value_facts (coordinate_id, present, payload, sequence) VALUES (?,?,?,?)',
							[cid, 0, '"x"', 1],
						);
				} else if (candidate.relation === 'unified') {
					db.run(
						'INSERT INTO facts (kind, namespace, local_key, row_id, present, payload, sequence) VALUES (?,?,?,?,?,?,?)',
						['value', VAL.namespace, VAL.value, '', 0, '"x"', 1],
					);
				} else {
					db.run(
						'INSERT INTO value_facts (namespace, local_key, present, payload, sequence) VALUES (?,?,?,?)',
						[VAL.namespace, VAL.value, 0, '"x"', 1],
					);
				}
			}),
		);
		db.close();
	}
	// A duplicate sequence within a table (OR REPLACE would hide this).
	{
		const db = fresh(candidate);
		const store = createStore(db, candidate);
		store.install({
			address: ROW,
			sequence: 5,
			presence: 'present',
			fields: { a: 1 },
		});
		check(
			'duplicate sequence',
			rejects(() =>
				store.install({
					address: { ...ROW, rowId: '00000000000000000000000b' },
					sequence: 5,
					presence: 'present',
					fields: { a: 1 },
				}),
			),
		);
		db.close();
	}
	// Split: a sequence collision across the two tables.
	if (candidate.relation === 'split') {
		const db = fresh(candidate);
		const store = createStore(db, candidate);
		store.install({
			address: ROW,
			sequence: 7,
			presence: 'present',
			fields: { a: 1 },
		});
		check(
			'cross-table sequence collision',
			rejects(() =>
				store.install({
					address: VAL,
					sequence: 7,
					presence: 'present',
					content: 1,
				}),
			),
		);
		db.close();
	}
	// Normalized: a referenced coordinate cannot mutate or be deleted.
	if (candidate.coordinates === 'normalized') {
		const db = fresh(candidate);
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
		db.close();
	}
	return failures;
}

/** The monotonic install must exercise stale, equal-identical, equal-different, and resurrection. */
export function storeTransactionProofs(candidate: Candidate): string[] {
	const failures: string[] = [];
	const db = fresh(candidate);
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
		'attempted row resurrection is refused',
		store.install({
			address: ROW,
			sequence: 10,
			presence: 'present',
			fields: { n: 3 },
		}) === 'corruption',
	);
	check('row stays tombstoned', store.get(ROW)?.presence === 'absent');

	db.close();
	return failures;
}

export function layoutsSelfTest(): string[] {
	const failures: string[] = [];
	for (const candidate of CANDIDATES) {
		failures.push(...negativeConstraintProofs(candidate));
		failures.push(...storeTransactionProofs(candidate));
	}
	return failures;
}
