/**
 * Relation-name admission, checked against the SQLite that will actually run.
 *
 * `SQLITE_UNUSABLE_AS_RELATION_NAME` encodes a property of SQLite's parser, not
 * a taste call, so it is verified against the linked engine rather than trusted.
 * If a SQLite upgrade changes which keywords parse as a bare relation, this
 * fails loudly here instead of silently producing a Lens that binds fine and
 * then cannot be inspected.
 *
 * Key behaviors:
 * - The constant matches the linked SQLite exactly, in both directions
 * - Every admissible table name really does mount and select without quoting
 * - Reserved and private relation names stay unreachable from a Lens
 */
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';

import { REPLICA_V1_TABLES } from '../replica/v1-schema.js';
import {
	DATA_ADDRESS_CEILINGS,
	isTableName,
	SQLITE_UNUSABLE_AS_RELATION_NAME,
} from './index.js';

/**
 * Every SQLite keyword.
 *
 * Carried here rather than read from the engine because Bun's SQLite is built
 * without the introspection pragmas (`pragma_keyword_name` is absent). This is
 * the candidate universe the partition below is checked over: each of these is
 * measured against the live engine, so a build that changes whether any one of
 * them parses as a relation name fails the assertion.
 */
const SQLITE_KEYWORDS = `abort action add after all alter always analyze and as
	asc attach autoincrement before begin between by cascade case cast check
	collate column commit conflict constraint create cross current current_date
	current_time current_timestamp database default deferrable deferred delete
	desc detach distinct do drop each else end escape except exclude exclusive
	exists explain fail filter first following for foreign from full generated
	glob group groups having if ignore immediate in index indexed initially inner
	insert instead intersect into is isnull join key last left like limit match
	materialized natural no not nothing notnull null nulls of offset on or order
	others outer over partition plan pragma preceding primary query raise range
	recursive references regexp reindex release rename replace restrict returning
	right rollback row rows savepoint select set table temp temporary then ties to
	transaction trigger unbounded union unique update using vacuum values view
	virtual when where window with without`.split(/\s+/);

/** Whether this SQLite can mount and query the name with no quoting at all. */
function usableAsRelationName(name: string): boolean {
	const database = new Database(':memory:');
	try {
		database.run(`CREATE TEMP VIEW ${name} AS SELECT 1 AS a`);
		database.prepare(`SELECT * FROM ${name}`).all();
		return true;
	} catch {
		return false;
	} finally {
		database.close();
	}
}

test('the refused-keyword set matches the linked SQLite exactly', () => {
	const measured = SQLITE_KEYWORDS.filter(
		(keyword) => !usableAsRelationName(keyword),
	).sort();
	expect(measured).toEqual([...SQLITE_UNUSABLE_AS_RELATION_NAME].sort());
});

test('every keyword the constant refuses really is unusable', () => {
	// The other direction, stated separately: nothing is refused for tidiness.
	for (const keyword of SQLITE_UNUSABLE_AS_RELATION_NAME) {
		expect(usableAsRelationName(keyword)).toBe(false);
		expect(isTableName(keyword, DATA_ADDRESS_CEILINGS)).toBe(false);
	}
});

test('every admitted table name mounts and selects without quoting', () => {
	// The whole promise of the table-name grammar, exercised against real SQLite:
	// if admission says yes, `SELECT * FROM <name>` must work verbatim.
	const candidates = [
		'notes',
		'folders',
		'conversations',
		'orders',
		'rows',
		'row',
		'key',
		'view',
		'first',
		'range',
		'filter',
		'selected_rows',
		'n1',
		'Notes',
	];
	for (const name of candidates) {
		expect(isTableName(name, DATA_ADDRESS_CEILINGS)).toBe(true);
		expect(usableAsRelationName(name)).toBe(true);
	}
});

test('no relation the replica owns can be named by a Lens', () => {
	// The reserved-name theorem. Every private relation is either underscore
	// prefixed, which the grammar cannot express, or explicitly reserved.
	for (const relation of REPLICA_V1_TABLES) {
		expect(isTableName(relation, DATA_ADDRESS_CEILINGS)).toBe(false);
	}
	for (const relation of ['_epicenter_rows', '_epicenter_values']) {
		expect(isTableName(relation, DATA_ADDRESS_CEILINGS)).toBe(false);
	}
});
