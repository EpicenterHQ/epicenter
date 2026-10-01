import { describe, expect, test } from 'bun:test';

import {
	DATA_ADDRESS_CEILINGS,
	isDataId,
	isRowId,
	isTableName,
} from './addresses.js';

describe('the durable name grammars (ADR-0206)', () => {
	test('a row id is safe verbatim in a path segment and never hides', () => {
		// A row still becomes one file in an exported folder (ADR-0268), so an
		// id that could be a relative segment or a dotfile is refused where it
		// is minted rather than escaped where it is written.
		for (const bad of ['.hidden', '-lead', '_lead', 'r/1', 'r 1', '']) {
			expect(isRowId(bad, DATA_ADDRESS_CEILINGS)).toBe(false);
		}
		expect(isRowId('abc123', DATA_ADDRESS_CEILINGS)).toBe(true);
		expect(isRowId('a.b-c_d', DATA_ADDRESS_CEILINGS)).toBe(true);
		// Case-sensitive, matching SQLite's default collation.
		expect(isRowId('App', DATA_ADDRESS_CEILINGS)).toBe(true);
	});

	test('a table name is a bare SQL identifier', () => {
		for (const bad of ['no/tes', '_internal', '1notes', 'order', '']) {
			expect(isTableName(bad, DATA_ADDRESS_CEILINGS)).toBe(false);
		}
		expect(isTableName('notes', DATA_ADDRESS_CEILINGS)).toBe(true);
	});

	test('a data id is reverse-domain', () => {
		for (const bad of ['honeycrisp', 'a/b.example', 'So.Example', '']) {
			expect(isDataId(bad, DATA_ADDRESS_CEILINGS)).toBe(false);
		}
		expect(isDataId('so.epicenter.honeycrisp', DATA_ADDRESS_CEILINGS)).toBe(
			true,
		);
	});

	test('a dotless segment is never a data id, so a sibling under an account prefix cannot collide', () => {
		// The browser blob store lives at `epicenter/v5/<app>/<principal>/blobs`,
		// beside `<data-id>/<n>` (ADR-0349). The grammar is what keeps them apart:
		// a data id is reverse-domain, so a bare word is never one, and any later
		// sibling spelled as a bare word inherits the same guarantee.
		for (const sibling of ['blobs', 'temp', 'derived', 'v5']) {
			expect(isDataId(sibling, DATA_ADDRESS_CEILINGS)).toBe(false);
		}
	});

	test('every grammar is bounded in bytes, not characters', () => {
		const ceilings = { dataIdBytes: 4, tableNameBytes: 4, rowIdBytes: 4 };
		expect(isRowId('aaaa', ceilings)).toBe(true);
		expect(isRowId('aaaaa', ceilings)).toBe(false);
		// One emoji is four UTF-8 bytes, and is not admitted by the grammar
		// anyway; a two-byte character is, and counts as two.
		expect(isTableName('aaaaa', ceilings)).toBe(false);
	});
});
