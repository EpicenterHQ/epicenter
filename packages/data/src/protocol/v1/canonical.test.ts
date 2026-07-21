/**
 * Scalar V1 Canonical Encoding and Request Hash Tests
 *
 * Proves the RFC 8785 (JSON Canonicalization Scheme) encoder and the SHA-256
 * request hash that the authority uses privately for exact-retry and fork
 * detection. Canonical equality across object insertion order is what lets a
 * lost-response retry and a byte admission agree across runtimes.
 *
 * Key behaviors:
 * - Object members serialize in UTF-16 code-unit key order, so a surrogate-pair
 *   key sorts by its leading surrogate (not by code point)
 * - Numbers use the ECMAScript Number-to-String form RFC 8785 adopts
 * - Only C0 control characters are escaped; U+0080 and above stay raw
 * - Insertion order does not change the canonical bytes or the request hash
 * - Cycles and shared references both reject; distinct-but-equal siblings encode
 * - SHA-256 matches NIST vectors
 *
 * Source stays ASCII-only: non-ASCII test vectors are built with
 * `String.fromCodePoint` so the exact code units under test are unambiguous.
 */
import { describe, expect, test } from 'bun:test';

import {
	canonicalize,
	isCanonicalJson,
	sha256Hex,
	utf8ByteLength,
} from './index.js';

const cp = (codePoint: number): string => String.fromCodePoint(codePoint);

describe('RFC 8785 canonical encoding', () => {
	test('object members sort by UTF-16 code unit, surrogate pair by leading surrogate', () => {
		// From RFC 8785 section 3.2.3. A code-point sort would place the emoji
		// (U+1F600) after U+FB33; the UTF-16 sort places it before, because its
		// leading surrogate is U+D83D.
		const input: Record<string, string> = {
			[cp(0x20ac)]: 'Euro Sign',
			[cp(0x0d)]: 'Carriage Return',
			[cp(0xfb33)]: 'Hebrew Letter Dalet With Dagesh',
			'1': 'One',
			[cp(0x1f600)]: 'Emoji: Grinning Face',
			[cp(0x80)]: 'Control',
			[cp(0xf6)]: 'Latin Small Letter O With Diaeresis',
		};
		const expected =
			'{"\\r":"Carriage Return",' +
			'"1":"One",' +
			`"${cp(0x80)}":"Control",` + // U+0080 stays raw in the canonical bytes
			`"${cp(0xf6)}":"Latin Small Letter O With Diaeresis",` +
			`"${cp(0x20ac)}":"Euro Sign",` +
			`"${cp(0x1f600)}":"Emoji: Grinning Face",` +
			`"${cp(0xfb33)}":"Hebrew Letter Dalet With Dagesh"}`;
		expect(canonicalize(input)).toBe(expected);
	});

	test('escapes only C0 control characters, leaving U+0080 raw', () => {
		expect(canonicalize(cp(0x00) + cp(0x1f))).toBe('"\\u0000\\u001f"');
		expect(canonicalize('a"\\\n\tb')).toBe('"a\\"\\\\\\n\\tb"');
		expect(canonicalize(cp(0x80))).toBe(`"${cp(0x80)}"`);
	});

	test('numbers use the ECMAScript representation', () => {
		expect(canonicalize(1)).toBe('1');
		expect(canonicalize(-0)).toBe('0');
		expect(canonicalize(0.1)).toBe('0.1');
		expect(canonicalize(1e21)).toBe('1e+21');
		expect(canonicalize(1e20)).toBe('100000000000000000000');
		expect(canonicalize(1e-7)).toBe('1e-7');
		expect(canonicalize(5e-324)).toBe('5e-324');
		expect(canonicalize(2 ** 53)).toBe('9007199254740992');
	});

	test('arrays keep element order and nested structure', () => {
		expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
		expect(canonicalize({ b: [2, { d: 1, c: 2 }], a: null })).toBe(
			'{"a":null,"b":[2,{"c":2,"d":1}]}',
		);
	});

	test('object insertion order does not change canonical bytes', () => {
		expect(canonicalize({ b: 1, a: 2, c: { z: 1, a: 2 } })).toBe(
			canonicalize({ c: { a: 2, z: 1 }, a: 2, b: 1 }),
		);
	});

	test('non-finite numbers and non-plain objects throw', () => {
		expect(() => canonicalize(Number.NaN)).toThrow();
		expect(() => canonicalize(Number.POSITIVE_INFINITY)).toThrow();
		expect(() => canonicalize(new Date(0))).toThrow();
	});

	test('cycles and shared references both reject; wire JSON is a tree', () => {
		const shared = { b: 1, a: 2 };
		const cycle: unknown[] = [];
		cycle.push(cycle);

		// The same object reached by two paths is not a tree. Refuse it rather than
		// emit it twice; the encoder has no byte budget and a graph of shared levels
		// would expand exponentially.
		expect(() => canonicalize([shared, shared])).toThrow('shared');
		expect(() => canonicalize(cycle)).toThrow('cyclic');
	});

	test('distinct-but-equal siblings are a tree and still encode', () => {
		// Refusal is by object identity, not by value: two separate objects with
		// equal content are a legitimate tree.
		expect(canonicalize([{ a: 1 }, { a: 1 }])).toBe('[{"a":1},{"a":1}]');
		expect(isCanonicalJson([{ a: 1 }, { a: 1 }], 5)).toBe(true);
	});

	test('a deep shared graph refuses instead of expanding exponentially', () => {
		// Each level reuses the level below twice. A tree encoder would emit 2^20
		// leaves; refusing repeated identity makes both the structural gate and the
		// encoder O(levels). `isCanonicalJson` must agree with `canonicalize`.
		const levels = 20;
		let node: Record<string, unknown> = { leaf: 0 };
		for (let level = 0; level < levels; level += 1) node = { a: node, b: node };

		expect(isCanonicalJson(node, levels * 2 + 2)).toBe(false);
		expect(() => canonicalize(node)).toThrow('shared');
	});
});

describe('SHA-256 request hash', () => {
	test('matches NIST vectors', () => {
		expect(sha256Hex('')).toBe(
			'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
		);
		expect(sha256Hex('abc')).toBe(
			'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
		);
		expect(sha256Hex('a'.repeat(56))).toBe(
			'b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a',
		);
	});

	test('hash of canonical bytes is insertion-order independent and content sensitive', () => {
		const left = sha256Hex(
			canonicalize({ replicaId: 'r', submissionNumber: 1 }),
		);
		const right = sha256Hex(
			canonicalize({ submissionNumber: 1, replicaId: 'r' }),
		);
		const other = sha256Hex(
			canonicalize({ replicaId: 'r', submissionNumber: 2 }),
		);
		expect(left).toBe(right);
		expect(left).not.toBe(other);
	});
});

describe('RFC 8785 Appendix B number coverage', () => {
	const vectors: Array<[number, string]> = [
		[0, '0'],
		[-0, '0'],
		[1, '1'],
		[-1, '-1'],
		[1.5, '1.5'],
		[100, '100'],
		[0.000001, '0.000001'],
		[1e-7, '1e-7'],
		[1e21, '1e+21'],
		[1e20, '100000000000000000000'],
		[5e-324, '5e-324'],
		[Number.MAX_VALUE, '1.7976931348623157e+308'],
		[2 ** 53, '9007199254740992'],
		[-(2 ** 53), '-9007199254740992'],
	];
	for (const [input, expected] of vectors) {
		test(`${expected} canonicalizes exactly`, () => {
			expect(canonicalize(input)).toBe(expected);
		});
	}
});

describe('defensive rejection of lone surrogates and non-JSON shapes', () => {
	const lone = String.fromCharCode(0xd800);

	test('a lone surrogate string throws', () => {
		expect(() => canonicalize(lone)).toThrow();
	});
	test('a lone surrogate object key throws', () => {
		expect(() => canonicalize({ [lone]: 1 })).toThrow();
	});
	test('a sparse array throws', () => {
		const sparse = [1, 2, 3];
		delete sparse[1];
		expect(() => canonicalize(sparse)).toThrow();
	});
	test('an array with an extra property throws', () => {
		const array: unknown[] = [1];
		(array as unknown as Record<string, unknown>).extra = 2;
		expect(() => canonicalize(array)).toThrow();
	});
	test('a symbol-keyed object throws', () => {
		const object: Record<string, unknown> = { a: 1 };
		(object as Record<symbol, unknown>)[Symbol('s')] = 2;
		expect(() => canonicalize(object)).toThrow();
	});
	test('an accessor property throws', () => {
		const object = {};
		Object.defineProperty(object, 'a', { get: () => 1, enumerable: true });
		expect(() => canonicalize(object)).toThrow();
	});
	test('a non-enumerable property throws', () => {
		const object = {};
		Object.defineProperty(object, 'a', { value: 1, enumerable: false });
		expect(() => canonicalize(object)).toThrow();
	});
});

describe('canonical values round-trip without semantic loss', () => {
	test('parsing the canonical form reproduces the value', () => {
		const values: unknown[] = [
			null,
			true,
			'plain',
			42,
			[1, 'two', false, null],
			{ b: 1, a: { z: [true], y: 'x' }, c: null },
			cp(0x1f600),
		];
		for (const value of values) {
			expect(JSON.parse(canonicalize(value))).toEqual(value);
		}
	});
});

describe('UTF-8 byte length', () => {
	test('counts encoded bytes, not code units', () => {
		expect(utf8ByteLength('abc')).toBe(3);
		expect(utf8ByteLength(cp(0x20ac))).toBe(3);
		expect(utf8ByteLength(cp(0x1f600))).toBe(4);
	});
});
