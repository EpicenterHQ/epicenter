/**
 * The mirror's rebuild gate, at its two levels.
 *
 * The digest: pinned against `shasum -a 256` so the encoding (canonical JSON,
 * the NUL domain separator, UTF-8 bytes) cannot drift silently. A drift here
 * would rebuild every mirror on earth once and then look correct forever, so it
 * is worth a vector rather than a round-trip.
 *
 * The declaration: what it must and must not contain. A change to the row shape
 * or a projection has to move the fingerprint (or a mirror keeps a table that no
 * longer matches the code); a change to anything runtime must not (or a re-pull
 * gets billed for a code change that touched no shape).
 */

import { describe, expect, test } from 'bun:test';
import {
	ENTITY_DEFS,
	MIRROR_DECLARATION,
	MIRROR_FINGERPRINT,
} from '../src/entities.ts';
import {
	canonicalJson,
	fingerprint,
	type JsonValue,
} from '../src/fingerprint.ts';

describe('canonical JSON', () => {
	test('sorts object keys, so authoring order carries no meaning', () => {
		expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
		expect(canonicalJson({ a: 2, b: 1 })).toBe('{"a":2,"b":1}');
	});

	test('keeps array order, because array order is meaning', () => {
		expect(canonicalJson([1, 2])).toBe('[1,2]');
		expect(canonicalJson([2, 1])).toBe('[2,1]');
	});

	test('sorts every level and emits no whitespace', () => {
		expect(canonicalJson({ b: 1, a: [3, 2], c: { z: null, y: 'x' } })).toBe(
			'{"a":[3,2],"b":1,"c":{"y":"x","z":null}}',
		);
	});

	test('refuses values JSON cannot carry', () => {
		expect(() => canonicalJson(Number.NaN)).toThrow(TypeError);
		expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(TypeError);
		// The type already forbids it; this pins what happens when a hole reaches
		// the encoder at runtime anyway.
		expect(() => canonicalJson(undefined as unknown as JsonValue)).toThrow(
			TypeError,
		);
	});
});

describe('the digest', () => {
	// Verified independently: printf 'test.v1\0{}' | shasum -a 256
	test('is SHA-256 over <domain>NUL<canonical json>', () => {
		expect(fingerprint('test.v1', {})).toBe(
			'c7ad934f6fa0a885cb3fb1282ca7e7c07b1cc7812b801bbddeb030d9674e559d',
		);
		expect(fingerprint('', 'abc')).toBe(
			'a474344da9b6174cdf649e0ff634d0631264f0f6fbaaaf9d48c331c63b5f20f4',
		);
	});

	test('separates domains, so two kinds of declaration cannot collide', () => {
		expect(fingerprint('a.v1', { x: 1 })).not.toBe(
			fingerprint('a.v2', { x: 1 }),
		);
	});

	test('ignores key order in the value it is given', () => {
		expect(fingerprint('d', { a: 1, b: { c: 2, d: 3 } })).toBe(
			fingerprint('d', { b: { d: 3, c: 2 }, a: 1 }),
		);
	});
});

/** The live declaration with one part replaced, for "does this move it?" checks. */
function withTables(tables: JsonValue): string {
	return fingerprint('probe', {
		...MIRROR_DECLARATION,
		tables,
	});
}

describe('the mirror declaration', () => {
	test('is the whole registry, sorted by entity so registry order is free', () => {
		expect(MIRROR_DECLARATION.tables.map((t) => t.entity)).toEqual(
			Object.keys(ENTITY_DEFS).sort(),
		);
	});

	test('carries the row shape every mirror table starts with', () => {
		expect(MIRROR_DECLARATION.row.map((c) => String(c.name))).toEqual([
			'id',
			'raw',
			'updated_at',
			'synced_at',
			'deleted',
		]);
	});

	test('holds nothing but the declared shape', () => {
		// No indexes, no data directory, no realm, no cursor, no credentials, no
		// configured entity subset: a mirror rebuilds when its shape changes, not
		// when its surroundings do.
		expect(Object.keys(MIRROR_DECLARATION).sort()).toEqual(['row', 'tables']);
		for (const table of MIRROR_DECLARATION.tables) {
			expect(Object.keys(table).sort()).toEqual(['columns', 'entity', 'table']);
		}
		expect(canonicalJson(MIRROR_DECLARATION)).not.toInclude('idx_');
	});

	test('has a stable fingerprint for one declaration', () => {
		expect(MIRROR_FINGERPRINT).toMatch(/^[0-9a-f]{64}$/);
		expect(MIRROR_FINGERPRINT).toBe(
			fingerprint(
				'epicenter.local-books.mirror-declaration.v1',
				MIRROR_DECLARATION,
			),
		);
	});

	test('moves when a projection changes', () => {
		const base = withTables(MIRROR_DECLARATION.tables);
		const [first, ...rest] = MIRROR_DECLARATION.tables;
		if (!first) throw new Error('the registry is empty');

		// A different JSON path behind the same column: same names, different data.
		const repathed = {
			...first,
			columns: first.columns.map((c, i) =>
				i === 0 ? { ...c, path: ['Somewhere', 'Else'] } : c,
			),
		};
		expect(withTables([repathed, ...rest])).not.toBe(base);

		// One column dropped.
		expect(
			withTables([{ ...first, columns: first.columns.slice(1) }, ...rest]),
		).not.toBe(base);

		// The same columns in a different order: a different physical table, and
		// the order the browse surface shows.
		expect(
			withTables([
				{ ...first, columns: [...first.columns].reverse() },
				...rest,
			]),
		).not.toBe(base);

		// A table renamed.
		expect(withTables([{ ...first, table: 'renamed' }, ...rest])).not.toBe(
			base,
		);
	});

	test('moves when the shared row shape changes', () => {
		const base = fingerprint('probe', MIRROR_DECLARATION);
		const constrained = MIRROR_DECLARATION.row.map((c) =>
			c.name === 'updated_at' ? { ...c, constraint: 'NOT NULL' } : c,
		);
		expect(
			fingerprint('probe', {
				...MIRROR_DECLARATION,
				row: constrained,
			}),
		).not.toBe(base);
	});
});
