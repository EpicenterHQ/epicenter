/**
 * The four confirmed-facts layout candidates, their stores, and proofs.
 *
 * relation layout: one unified `facts` table, or split `row_facts`/`value_facts`.
 * coordinate layout: inline structured coordinates, or a normalized
 * `coordinates` dictionary keyed by `(kind, namespace, local_key)`.
 *
 * Every candidate keeps the SAME closed current-fact state under DDL, not just
 * under the store, through three uniform per-table invariants enforced by BEFORE
 * triggers (so `RAISE(ABORT)` defeats OR REPLACE/OR IGNORE/UPSERT regardless of
 * recursive_triggers): every fact INSERT is a genuinely new address and a new
 * global sequence; every fact UPDATE keeps its address, strictly raises its
 * sequence, and never resurrects a row tombstone; and every fact DELETE is
 * refused (an owner reset drops the store). Coordinates are write-once
 * (unconditional no-update/no-delete), so foreign_keys OFF cannot orphan a fact.
 * Presence/payload validity is two-valued (a present fact requires a non-null
 * valid payload; an absent fact requires SQL NULL) and a normalized fact table
 * refuses a cross-kind coordinate. The store performs the ADR-0163 monotonic
 * install atomically (a nested transaction, so a rejected normalized fact leaves
 * no orphan coordinate) using INSERT for a new address and UPDATE for a
 * higher-sequence replacement, never an unconditional upsert. Reads never invent
 * content: a present fact with a null payload is corruption, not an empty object.
 * Point reads and the traverse and feed operations execute the exact SQL their
 * query plans explain. Storage is scoped to the candidate-varying tables. This
 * module owns no hashing: it yields plain facts and the trace owns the digest, so
 * no Bun crypto entangles layout logic.
 */
import type { SqliteDatabase } from '@epicenter/sqlite';

import { canonicalize } from '../../../packages/data/src/protocol/v1/canonical.js';
import {
	type Address,
	type Fact,
	factSetDigest,
	type JsonObject,
	type JsonValue,
	type RowAddress,
	type ValueAddress,
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

/**
 * Coordinates are write-once. After insertion no coordinate row may be updated
 * or deleted (unconditional, independent of recursive_triggers and
 * foreign_keys), so no OR REPLACE/OR IGNORE conflict path can move a live
 * coordinate onto a referenced id/identity or orphan a fact by deleting the
 * coordinate it references. A new coordinate must be genuinely new: never an
 * existing id or identity, so INSERT OR REPLACE cannot delete-then-replace one.
 * `coordinate_id >= 1` keeps the surrogate key a positive integer.
 */
function coordinateDdlStatements(): string[] {
	return [
		`CREATE TABLE coordinates (
  coordinate_id INTEGER PRIMARY KEY CHECK (typeof(coordinate_id) = 'integer' AND coordinate_id >= 1),
  kind TEXT NOT NULL CHECK (kind IN ('row', 'value')),
  namespace TEXT NOT NULL CHECK (typeof(namespace) = 'text' AND length(namespace) > 0),
  local_key TEXT NOT NULL CHECK (typeof(local_key) = 'text' AND length(local_key) > 0),
  UNIQUE (kind, namespace, local_key)
);`,
		`CREATE TRIGGER coordinates_no_update BEFORE UPDATE ON coordinates
BEGIN SELECT RAISE(ABORT, 'coordinates are immutable once inserted'); END;`,
		`CREATE TRIGGER coordinates_no_delete BEFORE DELETE ON coordinates
BEGIN SELECT RAISE(ABORT, 'coordinates are never deleted'); END;`,
		`CREATE TRIGGER coordinates_insert_new BEFORE INSERT ON coordinates
WHEN EXISTS (SELECT 1 FROM coordinates c WHERE c.coordinate_id = NEW.coordinate_id)
  OR EXISTS (SELECT 1 FROM coordinates c WHERE c.kind = NEW.kind AND c.namespace = NEW.namespace AND c.local_key = NEW.local_key)
BEGIN SELECT RAISE(ABORT, 'coordinate identity is immutable'); END;`,
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

type FactTableInvariants = {
	table: string;
	/** Existing-row match on NEW's primary address, defeating INSERT OR REPLACE. */
	addressMatch: string;
	/** NEW address differs from OLD; null-safe `IS NOT`, defeating UPDATE moves. */
	addressChanged: string;
	/** Sibling fact tables sharing the one global sequence space (split relation). */
	siblingTables: string[];
	/** True when the UPDATE is a terminal-row resurrection (absent then present). */
	rowResurrection: string;
};

/**
 * The three uniform fact-table invariants, enforced by BEFORE triggers so
 * `RAISE(ABORT)` defeats OR REPLACE/OR IGNORE/UPSERT regardless of
 * recursive_triggers: the statement aborts before any internal conflict-delete
 * or replace runs.
 *
 *  1. Every INSERT is genuinely new: no existing row shares its primary address,
 *     and no existing row in this table or a split sibling shares its sequence.
 *  2. Every UPDATE keeps the same address, strictly raises the sequence, never
 *     collides with another row's sequence (this table or a sibling), and never
 *     resurrects a terminal row tombstone.
 *  3. Every DELETE is refused; an owner reset drops and recreates the store.
 */
function factInvariantTriggers(inv: FactTableInvariants): string[] {
	const sequenceTaken = [inv.table, ...inv.siblingTables]
		.map((t) => `EXISTS (SELECT 1 FROM ${t} s WHERE s.sequence = NEW.sequence)`)
		.join('\n  OR ');
	return [
		`CREATE TRIGGER ${inv.table}_insert_new BEFORE INSERT ON ${inv.table}
WHEN EXISTS (SELECT 1 FROM ${inv.table} f WHERE ${inv.addressMatch})
  OR ${sequenceTaken}
BEGIN SELECT RAISE(ABORT, 'fact insert must use a new address and a new sequence'); END;`,
		`CREATE TRIGGER ${inv.table}_update_monotonic BEFORE UPDATE ON ${inv.table}
WHEN (${inv.addressChanged})
  OR NOT (NEW.sequence > OLD.sequence)
  OR ${sequenceTaken}
  OR (${inv.rowResurrection})
BEGIN SELECT RAISE(ABORT, 'fact update must keep its address, raise its sequence, and never resurrect'); END;`,
		`CREATE TRIGGER ${inv.table}_no_delete BEFORE DELETE ON ${inv.table}
BEGIN SELECT RAISE(ABORT, 'facts are never deleted; reset the store instead'); END;`,
	];
}

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
			...factInvariantTriggers({
				table: 'facts',
				addressMatch:
					'f.kind = NEW.kind AND f.namespace = NEW.namespace AND f.local_key = NEW.local_key AND f.row_id = NEW.row_id',
				addressChanged:
					'NEW.kind IS NOT OLD.kind OR NEW.namespace IS NOT OLD.namespace OR NEW.local_key IS NOT OLD.local_key OR NEW.row_id IS NOT OLD.row_id',
				siblingTables: [],
				rowResurrection:
					"OLD.kind = 'row' AND OLD.present = 0 AND NEW.present = 1",
			}),
		];
	}

	if (unified && normalized) {
		return [
			...coordinateDdlStatements(),
			`CREATE TABLE facts (
  coordinate_id INTEGER NOT NULL REFERENCES coordinates(coordinate_id),
  row_id TEXT NOT NULL,
  ${PRESENT_COL},
  payload TEXT,
  ${SEQUENCE_COL},
  PRIMARY KEY (coordinate_id, row_id)
) WITHOUT ROWID;`,
			...normalizedShapeTriggerStatements('facts', 'mixed'),
			...factInvariantTriggers({
				table: 'facts',
				addressMatch:
					'f.coordinate_id = NEW.coordinate_id AND f.row_id = NEW.row_id',
				addressChanged:
					'NEW.coordinate_id IS NOT OLD.coordinate_id OR NEW.row_id IS NOT OLD.row_id',
				siblingTables: [],
				rowResurrection:
					"(SELECT kind FROM coordinates WHERE coordinate_id = OLD.coordinate_id) = 'row' AND OLD.present = 0 AND NEW.present = 1",
			}),
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
			...factInvariantTriggers({
				table: 'row_facts',
				addressMatch:
					'f.namespace = NEW.namespace AND f.local_key = NEW.local_key AND f.row_id = NEW.row_id',
				addressChanged:
					'NEW.namespace IS NOT OLD.namespace OR NEW.local_key IS NOT OLD.local_key OR NEW.row_id IS NOT OLD.row_id',
				siblingTables: ['value_facts'],
				rowResurrection: 'OLD.present = 0 AND NEW.present = 1',
			}),
			...factInvariantTriggers({
				table: 'value_facts',
				addressMatch:
					'f.namespace = NEW.namespace AND f.local_key = NEW.local_key',
				addressChanged:
					'NEW.namespace IS NOT OLD.namespace OR NEW.local_key IS NOT OLD.local_key',
				siblingTables: ['row_facts'],
				rowResurrection: '0',
			}),
		];
	}

	return [
		...coordinateDdlStatements(),
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
		...factInvariantTriggers({
			table: 'row_facts',
			addressMatch:
				'f.coordinate_id = NEW.coordinate_id AND f.row_id = NEW.row_id',
			addressChanged:
				'NEW.coordinate_id IS NOT OLD.coordinate_id OR NEW.row_id IS NOT OLD.row_id',
			siblingTables: ['value_facts'],
			rowResurrection: 'OLD.present = 0 AND NEW.present = 1',
		}),
		...factInvariantTriggers({
			table: 'value_facts',
			addressMatch: 'f.coordinate_id = NEW.coordinate_id',
			addressChanged: 'NEW.coordinate_id IS NOT OLD.coordinate_id',
			siblingTables: ['row_facts'],
			rowResurrection: '0',
		}),
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
		// Select-then-insert inside the install transaction, never INSERT OR IGNORE
		// or OR REPLACE, so no conflict path can replace a referenced coordinate.
		const existing = db.all<{ coordinate_id: number }>(
			'SELECT coordinate_id FROM coordinates WHERE kind = ? AND namespace = ? AND local_key = ?',
			[address.kind, address.namespace, localKeyOf(address)],
		)[0];
		if (existing) return existing.coordinate_id;
		db.run(
			'INSERT INTO coordinates (kind, namespace, local_key) VALUES (?, ?, ?)',
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

function coordIdFor(db: SqliteDatabase, address: Address): number {
	const found = db.all<{ id: number }>(
		'SELECT coordinate_id AS id FROM coordinates WHERE kind = ? AND namespace = ? AND local_key = ?',
		[address.kind, address.namespace, localKeyOf(address)],
	)[0];
	if (!found) throw new Error('coordinate missing for raw attack address');
	return found.id;
}

/** Select-then-insert a coordinate (the store never upserts one), returning its id. */
function ensureCoordinateRaw(db: SqliteDatabase, address: Address): number {
	const existing = db.all<{ id: number }>(
		'SELECT coordinate_id AS id FROM coordinates WHERE kind = ? AND namespace = ? AND local_key = ?',
		[address.kind, address.namespace, localKeyOf(address)],
	)[0];
	if (existing) return existing.id;
	db.run(
		'INSERT INTO coordinates (kind, namespace, local_key) VALUES (?, ?, ?)',
		[address.kind, address.namespace, localKeyOf(address)],
	);
	return coordIdFor(db, address);
}

/** The physical primary-address columns of one fact under a candidate's layout. */
type Phys = {
	table: string;
	keyCols: string[];
	keyParams: (string | number)[];
};
function physOf(
	db: SqliteDatabase,
	candidate: Candidate,
	address: Address,
): Phys {
	const split = candidate.relation === 'split';
	const isRow = address.kind === 'row';
	const table = split ? (isRow ? 'row_facts' : 'value_facts') : 'facts';
	if (candidate.coordinates === 'normalized') {
		const cid = coordIdFor(db, address);
		if (isRow)
			return {
				table,
				keyCols: ['coordinate_id', 'row_id'],
				keyParams: [cid, rowIdOf(address)],
			};
		return split
			? { table, keyCols: ['coordinate_id'], keyParams: [cid] }
			: { table, keyCols: ['coordinate_id', 'row_id'], keyParams: [cid, ''] };
	}
	if (!split)
		return {
			table,
			keyCols: ['kind', 'namespace', 'local_key', 'row_id'],
			keyParams: [
				address.kind,
				address.namespace,
				localKeyOf(address),
				rowIdOf(address),
			],
		};
	return isRow
		? {
				table,
				keyCols: ['namespace', 'local_key', 'row_id'],
				keyParams: [address.namespace, localKeyOf(address), rowIdOf(address)],
			}
		: {
				table,
				keyCols: ['namespace', 'local_key'],
				keyParams: [address.namespace, localKeyOf(address)],
			};
}

const placeholders = (n: number): string =>
	Array.from({ length: n }, () => '?').join(', ');
const whereByKey = (p: Phys): string =>
	p.keyCols.map((col) => `${col} = ?`).join(' AND ');

/** Raw INSERT of a fact (optionally with an OR clause), bypassing the store. */
function rawInsertFact(
	db: SqliteDatabase,
	candidate: Candidate,
	address: Address,
	present: 0 | 1,
	payload: string | null,
	sequence: number,
	orClause = '',
): void {
	if (candidate.coordinates === 'normalized') ensureCoordinateRaw(db, address);
	const p = physOf(db, candidate, address);
	const cols = [...p.keyCols, 'present', 'payload', 'sequence'];
	db.run(
		`INSERT ${orClause} INTO ${p.table} (${cols.join(', ')}) VALUES (${placeholders(cols.length)})`,
		[...p.keyParams, present, payload, sequence],
	);
}
/** Raw UPDATE of a fact's sequence only. */
function rawUpdateSequence(
	db: SqliteDatabase,
	candidate: Candidate,
	address: Address,
	sequence: number,
	orClause = '',
): void {
	const p = physOf(db, candidate, address);
	db.run(
		`UPDATE ${orClause} ${p.table} SET sequence = ? WHERE ${whereByKey(p)}`,
		[sequence, ...p.keyParams],
	);
}
/** Raw UPDATE moving one fact's address onto another (same physical table). */
function rawMoveAddress(
	db: SqliteDatabase,
	candidate: Candidate,
	from: Address,
	to: Address,
	sequence: number,
	orClause = '',
): void {
	const pf = physOf(db, candidate, from);
	const pt = physOf(db, candidate, to);
	const set = [...pt.keyCols.map((col) => `${col} = ?`), 'sequence = ?'];
	db.run(
		`UPDATE ${orClause} ${pf.table} SET ${set.join(', ')} WHERE ${whereByKey(pf)}`,
		[...pt.keyParams, sequence, ...pf.keyParams],
	);
}
/** Raw UPDATE flipping a fact to present. */
function rawSetPresent(
	db: SqliteDatabase,
	candidate: Candidate,
	address: Address,
	sequence: number,
): void {
	const p = physOf(db, candidate, address);
	db.run(
		`UPDATE ${p.table} SET present = 1, payload = '{}', sequence = ? WHERE ${whereByKey(p)}`,
		[sequence, ...p.keyParams],
	);
}
/** Raw UPSERT (INSERT ... ON CONFLICT DO UPDATE) onto an existing identity. */
function rawUpsert(
	db: SqliteDatabase,
	candidate: Candidate,
	address: Address,
	sequence: number,
): void {
	const p = physOf(db, candidate, address);
	const cols = [...p.keyCols, 'present', 'payload', 'sequence'];
	db.run(
		`INSERT INTO ${p.table} (${cols.join(', ')}) VALUES (${placeholders(cols.length)}) ON CONFLICT(${p.keyCols.join(', ')}) DO UPDATE SET present = 1, payload = '{}', sequence = ?`,
		[...p.keyParams, 1, '{}', sequence, sequence],
	);
}

function coordinateCount(db: SqliteDatabase): number {
	return (
		db.all<{ n: number }>('SELECT count(*) AS n FROM coordinates')[0]?.n ?? 0
	);
}

/** Row/value/coordinate shape refusals that are not corruption-vector attacks. */
export function shapeProofs(candidate: Candidate, makeDb: MakeDb): string[] {
	const failures: string[] = [];
	const check = (name: string, ok: boolean): void => {
		if (!ok) failures.push(`${candidate.id}: ${name}`);
	};

	{
		const db = fresh(candidate, makeDb);
		const store = createStore(db, candidate);
		check(
			'short row id rejected',
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
	{
		const db = fresh(candidate, makeDb);
		check(
			'raw non-object row payload rejected',
			rejects(() => rawInsertFact(db, candidate, ROW, 1, '123', 1)),
		);
	}
	{
		const db = fresh(candidate, makeDb);
		check(
			'raw present row NULL payload rejected',
			rejects(() => rawInsertFact(db, candidate, ROW, 1, null, 1)),
		);
	}
	{
		const db = fresh(candidate, makeDb);
		check(
			'raw present value NULL payload rejected',
			rejects(() => rawInsertFact(db, candidate, VAL, 1, null, 1)),
		);
	}
	{
		// A present value carrying JSON null is stored as the text 'null', not rejected.
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
			'value present null stored',
			read?.presence === 'present' &&
				'content' in read &&
				read.content === null,
		);
	}
	if (candidate.coordinates === 'normalized') {
		{
			const db = fresh(candidate, makeDb);
			const cid = ensureCoordinateRaw(db, VAL);
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
		if (candidate.relation === 'split') {
			const db = fresh(candidate, makeDb);
			const cid = ensureCoordinateRaw(db, ROW);
			check(
				'value table refuses a row coordinate',
				rejects(() =>
					db.run(
						'INSERT INTO value_facts (coordinate_id, present, payload, sequence) VALUES (?,?,?,?)',
						[cid, 1, '1', 1],
					),
				),
			);
		}
		{
			// Atomic install: a rejected fact leaves no orphan coordinate.
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
	return failures;
}

const ROW_B: RowAddress = { ...ROW, rowId: '00000000000000000000000b' };
const ROW_C: RowAddress = { ...ROW, rowId: '00000000000000000000000c' };
const VAL_W: ValueAddress = { ...VAL, value: 'settingw' };
const VAL_UNREF: ValueAddress = { ...VAL, value: 'unref' };

function witnessOf(store: Store): {
	count: number;
	bytes: number;
	digest: string;
} {
	const w = factSetDigest(store.scanBySequence());
	return { count: w.count, bytes: w.bytes, digest: w.digestHex };
}
function integrityOf(db: SqliteDatabase): string {
	return (
		db.all<{ integrity_check: string }>('PRAGMA integrity_check')[0]
			?.integrity_check ?? 'unknown'
	);
}

/**
 * The corruption attack matrix. Every raw attack that bypasses the store must be
 * rejected AND leave the exact count/byte/SHA witness and `PRAGMA
 * integrity_check` unchanged, not merely throw. Run this across the pragma matrix
 * (recursive_triggers OFF/ON; normalized also foreign_keys OFF/ON): the `makeDb`
 * supplied by the caller sets those pragmas. The legal transitions at the end
 * (row absent then higher absent; value absent then higher present) must succeed.
 */
export function attackMatrixProofs(
	candidate: Candidate,
	makeDb: MakeDb,
): string[] {
	const failures: string[] = [];
	const db = fresh(candidate, makeDb);
	const store = createStore(db, candidate);
	// Known state: row A tombstoned (present@1, absent@2), row B present@5, value
	// V present@8. A, B, C share one (namespace, table); for normalized they share
	// one row coordinate, so distinct-PK attacks need no new coordinate.
	store.install({
		address: ROW,
		sequence: 1,
		presence: 'present',
		fields: { a: 1 },
	});
	store.install({ address: ROW, sequence: 2, presence: 'absent' });
	store.install({
		address: ROW_B,
		sequence: 5,
		presence: 'present',
		fields: { b: 2 },
	});
	store.install({
		address: VAL,
		sequence: 8,
		presence: 'present',
		content: 'v',
	});
	if (candidate.coordinates === 'normalized')
		ensureCoordinateRaw(db, VAL_UNREF); // an unreferenced coordinate for attack 11

	const base = witnessOf(store);
	if (integrityOf(db) !== 'ok')
		failures.push(`${candidate.id}: baseline integrity is not ok`);

	const attack = (name: string, run: () => void): void => {
		if (!rejects(run)) {
			failures.push(`${candidate.id}: attack "${name}" was NOT rejected`);
			return;
		}
		const w = witnessOf(store);
		if (
			w.count !== base.count ||
			w.bytes !== base.bytes ||
			w.digest !== base.digest
		)
			failures.push(`${candidate.id}: attack "${name}" mutated the witness`);
		if (integrityOf(db) !== 'ok')
			failures.push(`${candidate.id}: attack "${name}" broke integrity`);
	};

	attack('INSERT OR REPLACE same tombstone PK', () =>
		rawInsertFact(db, candidate, ROW, 1, '{}', 99, 'OR REPLACE'),
	);
	attack('INSERT OR REPLACE distinct PK using tombstone sequence', () =>
		rawInsertFact(db, candidate, ROW_C, 1, '{}', 2, 'OR REPLACE'),
	);
	attack('INSERT OR REPLACE same live PK', () =>
		rawInsertFact(db, candidate, ROW_B, 1, '{}', 99, 'OR REPLACE'),
	);
	attack('UPDATE OR REPLACE live address onto tombstone', () =>
		rawMoveAddress(db, candidate, ROW_B, ROW, 99, 'OR REPLACE'),
	);
	attack('UPDATE OR REPLACE sequence onto tombstone sequence (lower)', () =>
		rawUpdateSequence(db, candidate, ROW_B, 2, 'OR REPLACE'),
	);
	attack('UPDATE OR REPLACE sequence onto a taken sequence (higher)', () =>
		rawUpdateSequence(db, candidate, ROW_B, 8, 'OR REPLACE'),
	);
	attack('UPSERT same identity', () => rawUpsert(db, candidate, ROW, 99));
	attack('UPDATE OR IGNORE address conflict', () =>
		rawMoveAddress(db, candidate, ROW_B, ROW, 99, 'OR IGNORE'),
	);
	attack('UPDATE OR IGNORE sequence conflict', () =>
		rawUpdateSequence(db, candidate, ROW_B, 8, 'OR IGNORE'),
	);
	attack('direct DELETE one fact', () => {
		const p = physOf(db, candidate, ROW_B);
		db.run(`DELETE FROM ${p.table} WHERE ${whereByKey(p)}`, p.keyParams);
	});
	attack('direct DELETE all facts', () => {
		const p = physOf(db, candidate, ROW_B);
		db.run(`DELETE FROM ${p.table}`);
	});
	attack('raw row absent -> present', () =>
		rawSetPresent(db, candidate, ROW, 99),
	);
	if (candidate.relation === 'split')
		attack('split cross-table sequence insert', () =>
			rawInsertFact(db, candidate, VAL_W, 1, '"x"', 5),
		);
	if (candidate.coordinates === 'normalized') {
		const rowCoord = coordIdFor(db, ROW);
		const unref = coordIdFor(db, VAL_UNREF);
		attack('coordinate UPDATE', () =>
			db.run('UPDATE coordinates SET namespace = ? WHERE coordinate_id = ?', [
				'so.epicenter.ns99',
				rowCoord,
			]),
		);
		attack('coordinate DELETE', () =>
			db.run('DELETE FROM coordinates WHERE coordinate_id = ?', [rowCoord]),
		);
		attack('coordinate INSERT OR REPLACE existing id', () =>
			db.run(
				'INSERT OR REPLACE INTO coordinates (coordinate_id, kind, namespace, local_key) VALUES (?, ?, ?, ?)',
				[rowCoord, 'value', 'so.epicenter.ns88', 'settingq'],
			),
		);
		attack('coordinate INSERT OR REPLACE existing identity', () =>
			db.run(
				'INSERT OR REPLACE INTO coordinates (kind, namespace, local_key) VALUES (?, ?, ?)',
				['row', ROW.namespace, ROW.table],
			),
		);
		attack('unreferenced coordinate UPDATE OR REPLACE onto referenced id', () =>
			db.run(
				'UPDATE OR REPLACE coordinates SET coordinate_id = ? WHERE coordinate_id = ?',
				[rowCoord, unref],
			),
		);
		attack(
			'unreferenced coordinate UPDATE OR REPLACE onto referenced identity',
			() =>
				db.run(
					'UPDATE OR REPLACE coordinates SET kind = ?, namespace = ?, local_key = ? WHERE coordinate_id = ?',
					['row', ROW.namespace, ROW.table, unref],
				),
		);
		attack('orphan fact insert (foreign_keys off)', () => {
			db.run('PRAGMA foreign_keys = OFF');
			const table = candidate.relation === 'split' ? 'row_facts' : 'facts';
			db.run(
				`INSERT INTO ${table} (coordinate_id, row_id, present, payload, sequence) VALUES (?, ?, 1, '{}', 77)`,
				[999999, ROW.rowId],
			);
		});
	}

	// Legal transitions the invariants must still allow.
	const legal = (name: string, ok: boolean): void => {
		if (!ok)
			failures.push(`${candidate.id}: legal transition "${name}" failed`);
	};
	legal(
		'row absent -> absent (higher sequence)',
		store.install({ address: ROW, sequence: 20, presence: 'absent' }) ===
			'installed',
	);
	legal('row stays absent', store.get(ROW)?.presence === 'absent');
	legal(
		'value unset (absent)',
		store.install({ address: VAL, sequence: 21, presence: 'absent' }) ===
			'installed',
	);
	legal(
		'value absent -> present (higher sequence)',
		store.install({
			address: VAL,
			sequence: 22,
			presence: 'present',
			content: 'again',
		}) === 'installed',
	);
	legal('value present again', store.get(VAL)?.presence === 'present');

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

/** One candidate's full DDL constraint proof: shape, attack matrix, and install. */
export function candidateConstraintFailures(
	candidate: Candidate,
	makeDb: MakeDb,
): string[] {
	return [
		...shapeProofs(candidate, makeDb),
		...attackMatrixProofs(candidate, makeDb),
		...storeTransactionProofs(candidate, makeDb),
	];
}

export function layoutsSelfTest(makeDb: MakeDb): string[] {
	const failures: string[] = [];
	for (const candidate of CANDIDATES)
		failures.push(...candidateConstraintFailures(candidate, makeDb));
	return failures;
}
