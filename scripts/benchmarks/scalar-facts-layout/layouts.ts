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

/**
 * A structured query plan: one entry per independently-executed branch (the split
 * feed runs two, everything else one), each branch the ordered array of
 * `EXPLAIN QUERY PLAN` detail rows. Kept structured so EVERY branch and detail can
 * be validated on its own, never a concatenated string where one good branch
 * hides a broken sibling.
 */
export type QueryPlan = { branches: string[][] };

/**
 * The result of an atomic page install: either the whole page committed (with the
 * per-fact outcomes) or the whole page rolled back on the first corruption (with
 * its index). A corruption page writes nothing and advances no progress.
 */
export type PageResult =
	| { status: 'committed'; outcomes: InstallOutcome[] }
	| { status: 'corruption'; index: number; reason: string };

/** Internal sentinel: thrown inside the page transaction to force a full ROLLBACK. */
class PageRollback extends Error {
	constructor(readonly index: number) {
		super(`page rolled back at fact ${index}`);
	}
}

export type Store = {
	/**
	 * Install a page of facts in exactly one transaction; optional durable progress
	 * is written in that same transaction only if the whole page commits. Any
	 * corruption rolls the entire page back and writes no progress. The atomic seam.
	 */
	installPage(facts: Fact[], commitProgress?: () => void): PageResult;
	/** One-fact page, preserving the ignored/installed/corruption contract. */
	install(fact: Fact): InstallOutcome;
	get(address: Address): Fact | undefined;
	traverse(namespace: string, table: string): Fact[];
	feedPage(afterSequence: number, limit: number): Fact[];
	scanBySequence(): Iterable<Fact>;
	/** Structured `EXPLAIN QUERY PLAN` of the exact SQL each op executes, per branch. */
	queryPlan(op: PlanOp): QueryPlan;
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

// Grammar predicates over NEW, so a BEFORE trigger enforces them even when
// PRAGMA ignore_check_constraints is ON and every CHECK is bypassed. The CHECKs
// stay as defense-in-depth; the triggers own closure.
const PRESENT_OK = "typeof(NEW.present) = 'integer' AND NEW.present IN (0, 1)";
const SEQUENCE_OK =
	"typeof(NEW.sequence) = 'integer' AND NEW.sequence >= 1 AND NEW.sequence <= 9007199254740991";
const textNonEmpty = (col: string): string =>
	`typeof(${col}) = 'text' AND length(${col}) > 0`;
/** Two-valued present/absent payload rule for a kind expression over NEW. */
function payloadRuleFor(kindExpr: string): string {
	return `(CASE WHEN NEW.present = 0 THEN NEW.payload IS NULL WHEN ${kindExpr} = 'row' THEN NEW.payload IS NOT NULL AND json_valid(NEW.payload) AND json_type(NEW.payload) = 'object' ELSE NEW.payload IS NOT NULL AND json_valid(NEW.payload) END)`;
}
/** A BEFORE INSERT/UPDATE trigger pair that RAISE(ABORT)s when the predicate fails. */
function shapeTriggerPair(
	table: string,
	tag: string,
	predicate: string,
): string[] {
	const body = `WHEN NOT (${predicate})
BEGIN SELECT RAISE(ABORT, 'invalid ${tag}'); END;`;
	return [
		`CREATE TRIGGER ${table}_${tag}_insert BEFORE INSERT ON ${table} ${body}`,
		`CREATE TRIGGER ${table}_${tag}_update BEFORE UPDATE ON ${table} ${body}`,
	];
}

/**
 * Grammar triggers for an INLINE fact table, mirroring every correctness-critical
 * CHECK (kind, namespace/local-key non-empty, per-kind row-id grammar, per-kind
 * present/absent payload, present in {0,1}, sequence range) so ignore_check_
 * constraints cannot admit a malformed inline fact.
 */
function inlineGrammarTriggers(
	table: string,
	shape: 'unified' | 'row' | 'value',
): string[] {
	const parts: string[] = [];
	if (shape === 'unified') {
		parts.push("NEW.kind IN ('row', 'value')");
		parts.push(textNonEmpty('NEW.namespace'), textNonEmpty('NEW.local_key'));
		parts.push(
			`(CASE WHEN NEW.kind = 'row' THEN ${ROW_ID_OK('NEW.row_id')} ELSE NEW.row_id = '' END)`,
		);
		parts.push(payloadRuleFor('NEW.kind'));
	} else if (shape === 'row') {
		parts.push(textNonEmpty('NEW.namespace'), textNonEmpty('NEW.local_key'));
		parts.push(`(${ROW_ID_OK('NEW.row_id')})`);
		parts.push(payloadRuleFor("'row'"));
	} else {
		parts.push(textNonEmpty('NEW.namespace'), textNonEmpty('NEW.local_key'));
		parts.push(payloadRuleFor("'value'"));
	}
	parts.push(PRESENT_OK, SEQUENCE_OK);
	return shapeTriggerPair(table, 'grammar', parts.join(' AND '));
}

/**
 * Grammar trigger for the coordinates table, surviving ignore_check_constraints.
 * `coordinate_id` is the INTEGER PRIMARY KEY (rowid alias) and is NULL in a BEFORE
 * INSERT when auto-assigned, so it is not checked here (NOT NULL and the CHECK
 * cover it); the kind and namespace/local-key grammar is what must not be bypassed.
 */
function coordinateGrammarTriggers(): string[] {
	const predicate = [
		"NEW.kind IN ('row', 'value')",
		textNonEmpty('NEW.namespace'),
		textNonEmpty('NEW.local_key'),
	].join(' AND ');
	// Coordinates are already immutable (no update/delete), so INSERT alone.
	return [
		`CREATE TRIGGER coordinates_grammar_insert BEFORE INSERT ON coordinates
WHEN NOT (${predicate})
BEGIN SELECT RAISE(ABORT, 'invalid coordinate shape'); END;`,
	];
}

/**
 * Coordinates are write-once. After insertion no coordinate row may be updated
 * or deleted (unconditional, independent of recursive_triggers and
 * foreign_keys), so no OR REPLACE/OR IGNORE conflict path can move a live
 * coordinate onto a referenced id/identity or orphan a fact by deleting the
 * coordinate it references. A new coordinate must be genuinely new: never an
 * existing id or identity, so INSERT OR REPLACE cannot delete-then-replace one.
 * `coordinate_id` positivity is owned by the AFTER INSERT trigger below (which
 * still fires under ignore_check_constraints), NOT by the `coordinate_id >= 1`
 * CHECK, which is only defense-in-depth.
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
		// coordinate_id is the INTEGER PRIMARY KEY (rowid alias): it is NULL in a
		// BEFORE INSERT when auto-assigned, so its positivity cannot be checked
		// there. This AFTER INSERT trigger runs once the rowid is allocated and sees
		// the ACTUAL id, so it refuses zero/negative ids even with
		// ignore_check_constraints ON. RAISE(ABORT) rolls the insert back.
		`CREATE TRIGGER coordinates_id_positive AFTER INSERT ON coordinates
WHEN NOT (typeof(NEW.coordinate_id) = 'integer' AND NEW.coordinate_id >= 1)
BEGIN SELECT RAISE(ABORT, 'coordinate id must be a positive integer'); END;`,
		...coordinateGrammarTriggers(),
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
	const payloadRule = payloadRuleFor(kindExpr);
	// present/sequence added so ignore_check_constraints cannot bypass them either.
	const body = `WHEN NOT (${kindMatch} AND ${rowIdRule} AND ${payloadRule} AND ${PRESENT_OK} AND ${SEQUENCE_OK})
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
			...inlineGrammarTriggers('facts', 'unified'),
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
			...inlineGrammarTriggers('row_facts', 'row'),
			...inlineGrammarTriggers('value_facts', 'value'),
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
		// No single-letter aliases: EXPLAIN must expose the real base-table token so
		// the plan proof binds each access to a specific table, not an ambiguous alias.
		const kindExpr = kind ? `'${kind}'` : 'coordinates.kind';
		const rowIdExpr = kind === 'value' ? "''" : `${table}.row_id`;
		return `SELECT ${kindExpr} AS kind, coordinates.namespace AS namespace, coordinates.local_key AS local_key, ${rowIdExpr} AS row_id, ${table}.present AS present, ${table}.payload AS payload, ${table}.sequence AS sequence FROM ${table} JOIN coordinates ON coordinates.coordinate_id = ${table}.coordinate_id`;
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
	 * The pure ADR-0163 monotonic transition (read current, compare, write) for one
	 * fact. It opens NO transaction of its own, so it composes inside a page: the
	 * caller owns the single transaction. Read-compare-write still happens under
	 * that one transaction's write lock, so no interleaved write slips between the
	 * read and the write, and a rejected normalized fact's coordinate rolls back
	 * with the page.
	 */
	function applyInstall(fact: Fact): InstallOutcome {
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
	}

	/**
	 * Install a page of facts in EXACTLY ONE transaction. Every fact is applied
	 * through the non-transaction-opening inner op. If ANY fact is `corruption`, the
	 * WHOLE page rolls back and progress is NOT written: a corrupt page must never
	 * be half-applied nor advance a watermark. Otherwise (only `installed`/`ignored`
	 * outcomes) the optional durable progress is written in that same transaction
	 * and the page commits. Rollback is driven by a sentinel thrown inside the
	 * SQLite transaction (forcing ROLLBACK) and caught outside it, so the discarded
	 * writes never reach disk. Returns a discriminated result.
	 */
	function installPage(facts: Fact[], commitProgress?: () => void): PageResult {
		try {
			return db.transaction((): PageResult => {
				const outcomes: InstallOutcome[] = [];
				for (let index = 0; index < facts.length; index += 1) {
					const outcome = applyInstall(facts[index] as Fact);
					outcomes.push(outcome);
					if (outcome === 'corruption') throw new PageRollback(index);
				}
				commitProgress?.();
				return { status: 'committed', outcomes };
			});
		} catch (error) {
			if (error instanceof PageRollback)
				return {
					status: 'corruption',
					index: error.index,
					reason: `fact ${error.index} is corruption; page rolled back`,
				};
			throw error;
		}
	}

	/**
	 * One-fact page, preserving the ignored/installed/corruption contract. A corrupt
	 * fact rolls the (empty) page back and reports `corruption`, exactly as before.
	 */
	function install(fact: Fact): InstallOutcome {
		const result = installPage([fact]);
		return result.status === 'committed'
			? (result.outcomes[0] as InstallOutcome)
			: 'corruption';
	}

	const unifiedFeedSql = `${selectAll('facts', null, normalized)} WHERE sequence > ? ORDER BY sequence LIMIT ?`;
	const rowBranchSql = `${selectAll('row_facts', 'row', normalized)} WHERE sequence > ? ORDER BY sequence LIMIT ?`;
	const valueBranchSql = `${selectAll('value_facts', 'value', normalized)} WHERE sequence > ? ORDER BY sequence LIMIT ?`;
	function traverseSql(): string {
		if (normalized) {
			const table = split ? 'row_facts' : 'facts';
			return `SELECT 'row' AS kind, coordinates.namespace AS namespace, coordinates.local_key AS local_key, ${table}.row_id AS row_id, ${table}.present AS present, ${table}.payload AS payload, ${table}.sequence AS sequence FROM ${table} JOIN coordinates ON coordinates.coordinate_id = ${table}.coordinate_id WHERE coordinates.kind = 'row' AND coordinates.namespace = ? AND coordinates.local_key = ? ORDER BY ${table}.row_id`;
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
		installPage,
		install,
		get: (address) => {
			const row = selectRow(address);
			return row ? rowToFact(row) : undefined;
		},
		traverse: (namespace, table) =>
			db.all<Row>(traverseSql(), [namespace, table]).map(rowToFact),
		feedPage,
		scanBySequence,
		queryPlan: (op): QueryPlan => {
			const branch = (sql: string): string[] =>
				db
					.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`)
					.map((r) => r.detail);
			if (op === 'feed')
				return {
					branches: split
						? [branch(rowBranchSql), branch(valueBranchSql)]
						: [branch(unifiedFeedSql)],
				};
			if (op === 'traverse') return { branches: [branch(traverseSql())] };
			return {
				branches: [branch(pointSqlFor(op === 'rowPoint' ? 'row' : 'value'))],
			};
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

/**
 * A proof database handle the proof owns and must close. `close` is optional so a
 * caller may still return a bare in-memory adapter, but the real factories attach
 * it and every proof closes in a `finally`, so no handle leaks.
 */
export type ProofDb = SqliteDatabase & { close?: () => void };
export type MakeDb = (statements: string[]) => ProofDb;

function fresh(candidate: Candidate, makeDb: MakeDb): ProofDb {
	return makeDb(ddlStatements(candidate));
}

/** Open a proof database, run `fn` with it, and always close it. */
function withProofDb<T>(
	candidate: Candidate,
	makeDb: MakeDb,
	fn: (db: ProofDb) => T,
): T {
	const db = fresh(candidate, makeDb);
	try {
		return fn(db);
	} finally {
		db.close?.();
	}
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

/** The exact RAISE(ABORT) messages our triggers use; a raise must match one exactly. */
const KNOWN_RAISE_MESSAGES: readonly string[] = [
	'coordinates are immutable once inserted',
	'coordinates are never deleted',
	'coordinate identity is immutable',
	'coordinate id must be a positive integer',
	'invalid coordinate shape',
	'invalid normalized fact shape',
	'invalid grammar',
	'fact insert must use a new address and a new sequence',
	'fact update must keep its address, raise its sequence, and never resurrect',
	'facts are never deleted; reset the store instead',
];

/** The structured identity of a thrown SQLite error, not just its lossy message. */
export type ObservedError = {
	message: string;
	code: string | null;
	errno: number | null;
	name: string | null;
};
const NO_ERROR: ObservedError = {
	message: '',
	code: null,
	errno: null,
	name: null,
};

/** Extract the structured error identity (bun:sqlite exposes code/errno/name). */
function toObservedError(error: unknown): ObservedError {
	if (error && typeof error === 'object') {
		const e = error as Record<string, unknown>;
		return {
			message: typeof e.message === 'string' ? e.message : String(error),
			code: typeof e.code === 'string' ? e.code : null,
			errno: typeof e.errno === 'number' ? e.errno : null,
			name: typeof e.name === 'string' ? e.name : null,
		};
	}
	return { ...NO_ERROR, message: String(error) };
}

/**
 * Classify a thrown error by its ACTUAL SQLite identity, not substrings. A genuine
 * trigger refusal has code `SQLITE_CONSTRAINT_TRIGGER` and an exact known RAISE
 * message; any other `SQLITE_CONSTRAINT_*` code is a genuine constraint refusal.
 * A SQL typo, missing table, or syntax error has no constraint code (bun reports
 * `code` undefined, `errno` 1) and is classified `other`, so it cannot masquerade
 * as an invariant refusal.
 */
export function refusalClass(
	error: ObservedError,
): 'raise' | 'constraint' | 'other' {
	if (
		error.code === 'SQLITE_CONSTRAINT_TRIGGER' &&
		KNOWN_RAISE_MESSAGES.includes(error.message)
	) {
		return 'raise';
	}
	if (
		typeof error.code === 'string' &&
		error.code.startsWith('SQLITE_CONSTRAINT')
	)
		return 'constraint';
	return 'other';
}

/** Run an op, returning whether it threw and (if so) the structured error identity. */
function observeThrow(run: () => void): {
	rejected: boolean;
	error: ObservedError;
} {
	try {
		run();
		return { rejected: false, error: NO_ERROR };
	} catch (error) {
		return { rejected: true, error: toObservedError(error) };
	}
}

/** True iff `run` threw a GENUINE refusal (trigger raise or a real constraint). */
function refusesGenuinely(run: () => void): {
	genuine: boolean;
	error: ObservedError;
} {
	const observed = observeThrow(run);
	const genuine = observed.rejected && refusalClass(observed.error) !== 'other';
	return { genuine, error: observed.error };
}

/** A correctness-relevant pragma tuple, as requested and as observed in a record. */
export type PragmaTuple = {
	recursiveTriggers: boolean;
	foreignKeys: boolean;
	ignoreCheckConstraints: boolean;
};
const pragmaTupleKey = (p: PragmaTuple): string =>
	`rt=${p.recursiveTriggers ? 1 : 0} fk=${p.foreignKeys ? 1 : 0} icc=${p.ignoreCheckConstraints ? 1 : 0}`;

/**
 * Verify the OBSERVED pragma tuples (read back from each record's database) match
 * the REQUESTED tuples exactly: same set, each occurring once, none ignored,
 * missing, or duplicated. Returns the list of failures (empty means clean).
 */
export function verifyPragmaCoverage(
	requested: PragmaTuple[],
	observed: PragmaTuple[],
): string[] {
	const failures: string[] = [];
	requested.forEach((combo, i) => {
		const got = observed[i];
		if (got && pragmaTupleKey(got) !== pragmaTupleKey(combo))
			failures.push(
				`observed pragmas [${pragmaTupleKey(got)}] != requested [${pragmaTupleKey(combo)}]`,
			);
	});
	if (requested.length !== observed.length)
		failures.push(
			`observed ${observed.length} records for ${requested.length} requested combos`,
		);
	const requestedKeys = requested.map(pragmaTupleKey);
	const requestedSet = new Set(requestedKeys);
	if (requestedSet.size !== requestedKeys.length)
		failures.push('requested pragma combos are not distinct');
	const observedCount = new Map<string, number>();
	for (const o of observed) {
		const k = pragmaTupleKey(o);
		observedCount.set(k, (observedCount.get(k) ?? 0) + 1);
	}
	for (const k of requestedSet)
		if ((observedCount.get(k) ?? 0) !== 1)
			failures.push(`pragma tuple [${k}] not present exactly once`);
	for (const [k, n] of observedCount)
		if (!requestedSet.has(k) || n !== 1)
			failures.push(`unexpected/duplicate pragma tuple [${k}] (x${n})`);
	return failures;
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

/**
 * Row/value/coordinate shape refusals that are not corruption-vector attacks.
 * Every refusal must be a GENUINE SQLite refusal (a trigger raise or a real
 * constraint), never a SQL-typo/missing-table masquerade, and every proof
 * database is closed. The positive checks (value-null stored; a rejected install
 * leaves no orphan coordinate) assert real behavior.
 */
export function shapeProofs(candidate: Candidate, makeDb: MakeDb): string[] {
	const failures: string[] = [];
	const check = (name: string, ok: boolean): void => {
		if (!ok) failures.push(`${candidate.id}: ${name}`);
	};
	/** Assert `run` is refused by a genuine SQLite refusal, not a masquerade. */
	const refuses = (name: string, run: () => void): void => {
		const { genuine, error } = refusesGenuinely(run);
		if (!genuine)
			failures.push(
				`${candidate.id}: ${name} not refused genuinely (code=${error.code}, msg=${error.message})`,
			);
	};

	withProofDb(candidate, makeDb, (db) => {
		const store = createStore(db, candidate);
		refuses('short row id', () =>
			store.install({
				address: { ...ROW, rowId: 'tooShort' },
				sequence: 1,
				presence: 'present',
				fields: {},
			}),
		);
	});
	withProofDb(candidate, makeDb, (db) => {
		refuses('raw non-object row payload', () =>
			rawInsertFact(db, candidate, ROW, 1, '123', 1),
		);
	});
	withProofDb(candidate, makeDb, (db) => {
		refuses('raw present row NULL payload', () =>
			rawInsertFact(db, candidate, ROW, 1, null, 1),
		);
	});
	withProofDb(candidate, makeDb, (db) => {
		refuses('raw present value NULL payload', () =>
			rawInsertFact(db, candidate, VAL, 1, null, 1),
		);
	});
	withProofDb(candidate, makeDb, (db) => {
		// A present value carrying JSON null is stored as the text 'null', not rejected.
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
	});
	if (candidate.coordinates === 'normalized') {
		withProofDb(candidate, makeDb, (db) => {
			const cid = ensureCoordinateRaw(db, VAL);
			const rowTable = candidate.relation === 'split' ? 'row_facts' : 'facts';
			refuses('row table refuses a value coordinate', () =>
				db.run(
					`INSERT INTO ${rowTable} (coordinate_id, row_id, present, payload, sequence) VALUES (?,?,?,?,?)`,
					[cid, ROW.rowId, 1, '{}', 1],
				),
			);
		});
		if (candidate.relation === 'split') {
			withProofDb(candidate, makeDb, (db) => {
				const cid = ensureCoordinateRaw(db, ROW);
				refuses('value table refuses a row coordinate', () =>
					db.run(
						'INSERT INTO value_facts (coordinate_id, present, payload, sequence) VALUES (?,?,?,?)',
						[cid, 1, '1', 1],
					),
				);
			});
		}
		withProofDb(candidate, makeDb, (db) => {
			// Atomic install: a rejected fact is refused genuinely AND leaves no orphan.
			const store = createStore(db, candidate);
			const before = coordinateCount(db);
			refuses('atomic install of a bad fact', () =>
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
		});
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
 * One attack's structured result. The RAW observations (the exact after-attack
 * witness and integrity string) are retained as the auditable transcript; the
 * booleans are derived from them for convenience, never a substitute for the raw
 * observation.
 */
export type AttackResult = {
	name: string;
	rejected: boolean;
	/** The structured thrown error identity (message/code/errno/name) and its
	 * refusal class. A masquerade (a SQL typo or missing table, `code` undefined) is
	 * class `other` and fails the attack, since it is not a genuine invariant
	 * refusal. */
	observedError: ObservedError;
	refusalClass: 'raise' | 'constraint' | 'other';
	observedWitness: { count: number; bytes: number; digest: string };
	observedIntegrity: string;
	witnessStable: boolean;
	integrityOk: boolean;
};

/**
 * A named, retained proof record for one candidate under one pragma setting: the
 * baseline witness and integrity, every attack's structured result, whether the
 * legal transitions held, and the derived failures and pass flag. This is the
 * typed evidence the artifact retains, so the recorded coverage is real, not a
 * summary boolean asserted by fiat.
 */
export type ConstraintProofRecord = {
	candidateId: string;
	pragmas: {
		recursiveTriggers: boolean;
		foreignKeys: boolean;
		ignoreCheckConstraints: boolean;
	};
	baseline: { count: number; bytes: number; digest: string; integrity: string };
	attacks: AttackResult[];
	legalTransitionsOk: boolean;
	failures: string[];
	ok: boolean;
};

function pragmaOn(db: SqliteDatabase, name: string): boolean {
	return (
		(db.all<Record<string, number>>(`PRAGMA ${name}`)[0]?.[name] ?? 0) === 1
	);
}

/**
 * The corruption attack matrix as a retained proof record. Every raw attack that
 * bypasses the store must be rejected AND leave the exact count/byte/SHA witness
 * and `PRAGMA integrity_check` unchanged, not merely throw. Run this across the
 * pragma matrix (recursive_triggers OFF/ON; normalized also foreign_keys OFF/ON):
 * the `makeDb` supplied by the caller sets those pragmas, which the record reads
 * back. The legal transitions at the end (row absent then higher absent; value
 * absent then higher present) must succeed.
 */
export function attackMatrixProof(
	candidate: Candidate,
	makeDb: MakeDb,
): ConstraintProofRecord {
	const failures: string[] = [];
	const attacks: AttackResult[] = [];
	const db = fresh(candidate, makeDb);
	try {
		const pragmas = {
			recursiveTriggers: pragmaOn(db, 'recursive_triggers'),
			foreignKeys: pragmaOn(db, 'foreign_keys'),
			ignoreCheckConstraints: pragmaOn(db, 'ignore_check_constraints'),
		};
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
		const baselineIntegrity = integrityOf(db);
		if (baselineIntegrity !== 'ok')
			failures.push(`${candidate.id}: baseline integrity is not ok`);

		const attack = (name: string, run: () => void): void => {
			const observed = observeThrow(run);
			const cls = observed.rejected ? refusalClass(observed.error) : 'other';
			const observedWitness = witnessOf(store);
			const observedIntegrity = integrityOf(db);
			const witnessStable =
				observedWitness.count === base.count &&
				observedWitness.bytes === base.bytes &&
				observedWitness.digest === base.digest;
			const integrityOk = observedIntegrity === 'ok';
			attacks.push({
				name,
				rejected: observed.rejected,
				observedError: observed.error,
				refusalClass: cls,
				observedWitness,
				observedIntegrity,
				witnessStable,
				integrityOk,
			});
			if (!observed.rejected)
				failures.push(`${candidate.id}: attack "${name}" was NOT rejected`);
			// A rejection must be a GENUINE trigger/constraint refusal, never a SQL typo
			// or missing-table masquerade (which would be class `other`).
			else if (cls === 'other')
				failures.push(
					`${candidate.id}: attack "${name}" rejected by a non-refusal error (code=${observed.error.code}): ${observed.error.message}`,
				);
			if (!witnessStable)
				failures.push(`${candidate.id}: attack "${name}" mutated the witness`);
			if (!integrityOk)
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
		// Grammar refusals: these must hold even when checks are ignored (they run in
		// the pragma matrix with ignore_check_constraints ON), so a trigger, not a
		// CHECK, must reject each. Fresh addresses/sequences isolate the grammar cause.
		attack('raw short row id', () =>
			rawInsertFact(db, candidate, { ...ROW, rowId: 'short' }, 1, '{}', 50),
		);
		attack('raw scalar row payload', () =>
			rawInsertFact(
				db,
				candidate,
				{ ...ROW, rowId: '00000000000000000000000e' },
				1,
				'123',
				51,
			),
		);
		attack('raw present row null payload', () =>
			rawInsertFact(
				db,
				candidate,
				{ ...ROW, rowId: '00000000000000000000000f' },
				1,
				null,
				52,
			),
		);
		attack('raw absent fact carrying a payload', () =>
			rawInsertFact(
				db,
				candidate,
				{ ...ROW, rowId: '00000000000000000000000g' },
				0,
				'{}',
				53,
			),
		);
		attack('raw invalid value payload', () =>
			rawInsertFact(
				db,
				candidate,
				{ ...VAL, value: 'settingx' },
				1,
				'not json',
				54,
			),
		);
		attack('raw UPDATE to an invalid payload (checks ignored)', () => {
			const p = physOf(db, candidate, ROW_B);
			db.run(
				`UPDATE ${p.table} SET payload = '123', sequence = 60 WHERE ${whereByKey(p)}`,
				p.keyParams,
			);
		});
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
			attack(
				'unreferenced coordinate UPDATE OR REPLACE onto referenced id',
				() =>
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
			// Coordinate grammar refusals (must survive ignore_check_constraints).
			attack('raw invalid coordinate kind', () =>
				db.run(
					"INSERT INTO coordinates (kind, namespace, local_key) VALUES ('bogus', 'so.epicenter.ns00', 'settingk')",
				),
			);
			attack('raw empty coordinate namespace', () =>
				db.run(
					"INSERT INTO coordinates (kind, namespace, local_key) VALUES ('value', '', 'settingk')",
				),
			);
			attack('raw empty coordinate local key', () =>
				db.run(
					"INSERT INTO coordinates (kind, namespace, local_key) VALUES ('value', 'so.epicenter.ns00', '')",
				),
			);
			attack('raw negative coordinate id', () =>
				db.run(
					"INSERT INTO coordinates (coordinate_id, kind, namespace, local_key) VALUES (-7, 'value', 'so.epicenter.ns00', 'settingn')",
				),
			);
			attack('raw zero coordinate id', () =>
				db.run(
					"INSERT INTO coordinates (coordinate_id, kind, namespace, local_key) VALUES (0, 'value', 'so.epicenter.ns00', 'settingo')",
				),
			);
		}

		// Legal transitions the invariants must still allow.
		let legalTransitionsOk = true;
		const legal = (name: string, ok: boolean): void => {
			if (!ok) {
				legalTransitionsOk = false;
				failures.push(`${candidate.id}: legal transition "${name}" failed`);
			}
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

		return {
			candidateId: candidate.id,
			pragmas,
			baseline: {
				count: base.count,
				bytes: base.bytes,
				digest: base.digest,
				integrity: baselineIntegrity,
			},
			attacks,
			legalTransitionsOk,
			failures,
			ok: failures.length === 0,
		};
	} finally {
		db.close?.();
	}
}

/** The attack matrix as a flat failure list, for the self-test. */
export function attackMatrixProofs(
	candidate: Candidate,
	makeDb: MakeDb,
): string[] {
	return attackMatrixProof(candidate, makeDb).failures;
}

/** The monotonic install must exercise stale, equal-identical, equal-different, and resurrection. */
export function storeTransactionProofs(
	candidate: Candidate,
	makeDb: MakeDb,
): string[] {
	const failures: string[] = [];
	return withProofDb(candidate, makeDb, (db) => {
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
	});
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
