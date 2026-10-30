/**
 * Table name grammar tests.
 *
 * A table name is a bare SQL identifier within its byte ceiling.
 */
import { expect, test } from 'bun:test';

import { isTableName } from './table-name.js';

test('a table name is a bare SQL identifier', () => {
	for (const bad of [
		'no/tes',
		'_internal',
		'1notes',
		'order',
		'ORDER',
		'sqlite_notes',
		'SQLITE_notes',
		'',
	]) {
		expect(isTableName(bad)).toBe(false);
	}
	expect(isTableName('notes')).toBe(true);
});

test('a table name admits its ceiling and refuses a longer name', () => {
	expect(isTableName('a'.repeat(64))).toBe(true);
	expect(isTableName('a'.repeat(65))).toBe(false);
});
