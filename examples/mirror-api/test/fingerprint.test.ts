import { describe, expect, test } from 'bun:test';
import { booksMirror } from '../mirrors/books.ts';
import { mailMirror } from '../mirrors/mail.ts';
import {
	CanonicalizationError,
	canonicalize,
	computeFingerprint,
	defineMirror,
	derived,
	path,
	rebuildRelevant,
	table,
} from '../src/index.ts';

type Thing = { id: string; v: string; a: number; b?: { c: string } };

const base = () =>
	defineMirror({
		name: 'thing',
		tables: {
			things: table<Thing>({
				key: path('id'),
				version: { from: path('v'), order: 'lexical' },
				columns: {
					a: { type: 'real', from: path('a') },
					c: { type: 'text', from: path('b', 'c'), nullable: true },
				},
			}),
		},
	});

describe('canonical serialization', () => {
	test('sorts object keys so authoring order is not rebuild behavior', () => {
		expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
		expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
	});

	test('preserves array order, because order is meaning', () => {
		expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]));
	});

	test('rejects values whose spelling is not stable', () => {
		expect(() => canonicalize({ a: undefined })).toThrow(CanonicalizationError);
		expect(() => canonicalize(() => 1)).toThrow(CanonicalizationError);
		expect(() => canonicalize(Number.NaN)).toThrow(CanonicalizationError);
		expect(() => canonicalize(new Date())).toThrow(CanonicalizationError);
		expect(() => canonicalize(10n)).toThrow(CanonicalizationError);
	});

	test('the domain tag keeps a bare JSON digest from colliding', () => {
		const value = { tables: {}, derives: [] };
		const bare = new Bun.CryptoHasher('sha256')
			.update(canonicalize(value))
			.digest('hex');
		expect(computeFingerprint(value)).not.toBe(`sha256:${bare}`);
	});
});

describe('what the gate ignores', () => {
	test('reordering the declaration does not rebuild', () => {
		const reordered = defineMirror({
			tables: {
				things: table<Thing>({
					columns: {
						c: { nullable: true, from: path('b', 'c'), type: 'text' },
						a: { from: path('a'), type: 'real' },
					},
					version: { order: 'lexical', from: path('v') },
					key: path('id'),
				}),
			},
			name: 'thing',
		});
		expect(reordered.fingerprint).toBe(base().fingerprint);
	});

	test('renaming the mirror does not rebuild: a label stores no bytes', () => {
		const renamed = defineMirror({ ...base(), name: 'thing-renamed' });
		expect(renamed.fingerprint).toBe(base().fingerprint);
	});

	test('adding an index does not rebuild: a query plan holds no facts', () => {
		const indexed = defineMirror({
			name: 'thing',
			tables: {
				things: table<Thing>({
					key: path('id'),
					version: { from: path('v'), order: 'lexical' },
					columns: {
						a: { type: 'real', from: path('a') },
						c: { type: 'text', from: path('b', 'c'), nullable: true },
					},
					indexes: [['a'], ['c', 'a']],
				}),
			},
		});
		expect(indexed.fingerprint).toBe(base().fingerprint);
	});
});

describe('what the gate catches', () => {
	const differs = (mirror: { fingerprint: string }) =>
		expect(mirror.fingerprint).not.toBe(base().fingerprint);

	test('a new column', () => {
		differs(
			defineMirror({
				name: 'thing',
				tables: {
					things: table<Thing>({
						key: path('id'),
						version: { from: path('v'), order: 'lexical' },
						columns: {
							a: { type: 'real', from: path('a') },
							c: { type: 'text', from: path('b', 'c'), nullable: true },
							d: { type: 'text', from: path('id') },
						},
					}),
				},
			}),
		);
	});

	test('a column type change', () => {
		differs(
			defineMirror({
				name: 'thing',
				tables: {
					things: table<Thing>({
						key: path('id'),
						version: { from: path('v'), order: 'lexical' },
						columns: {
							a: { type: 'integer', from: path('a') },
							c: { type: 'text', from: path('b', 'c'), nullable: true },
						},
					}),
				},
			}),
		);
	});

	test('a nullability change', () => {
		differs(
			defineMirror({
				name: 'thing',
				tables: {
					things: table<Thing>({
						key: path('id'),
						version: { from: path('v'), order: 'lexical' },
						columns: {
							a: { type: 'real', from: path('a') },
							c: { type: 'text', from: path('b', 'c') },
						},
					}),
				},
			}),
		);
	});

	test('a version order change, because it picks the physical column type', () => {
		differs(
			defineMirror({
				name: 'thing',
				tables: {
					things: table<Thing>({
						key: path('id'),
						version: { from: path('v'), order: 'numeric' },
						columns: {
							a: { type: 'real', from: path('a') },
							c: { type: 'text', from: path('b', 'c'), nullable: true },
						},
					}),
				},
			}),
		);
	});

	test('a path change, including a reordering of its segments', () => {
		differs(
			defineMirror({
				name: 'thing',
				tables: {
					things: table<Thing>({
						key: path('id'),
						version: { from: path('v'), order: 'lexical' },
						columns: {
							a: { type: 'real', from: path('a') },
							c: { type: 'text', from: path('c', 'b'), nullable: true },
						},
					}),
				},
			}),
		);
	});
});

describe('the hole the gate cannot see, reported as data', () => {
	const withCompute = (multiplier: number) =>
		defineMirror({
			name: 'thing',
			tables: {
				things: table<Thing>({
					key: path('id'),
					version: { from: path('v'), order: 'lexical' },
					columns: { a: { type: 'real', from: (t) => t.a * multiplier } },
				}),
			},
		});

	test('two different function bodies fingerprint identically', () => {
		expect(withCompute(1).fingerprint).toBe(withCompute(100).fingerprint);
	});

	test('but the declaration names every path the gate is blind to', () => {
		expect(withCompute(1).unfingerprintedPaths).toEqual([
			'tables.things.columns.a.from',
		]);
	});

	test('a fully declarative mirror reports an empty blind set', () => {
		expect(booksMirror.unfingerprintedPaths).toEqual([]);
	});

	test('an imperative mirror names its derive and its computed columns', () => {
		expect(mailMirror.unfingerprintedPaths).toEqual([
			'derive.messages',
			'tables.messages.columns.internalDate.from',
			'tables.messages.columns.subject.from',
		]);
	});

	test('the set of imperatively derived sources is still shape', () => {
		const one = defineMirror({
			name: 'm',
			tables: {
				src: table<Thing>({
					key: path('id'),
					version: { from: path('v'), order: 'lexical' },
					columns: { a: { type: 'real', from: path('a') } },
				}),
				kids: derived({
					of: 'src',
					key: 'k',
					columns: { k: 'text' },
				}),
			},
			derive: { src: () => {} },
		});
		const withoutDerived = defineMirror({
			name: 'm',
			tables: {
				src: table<Thing>({
					key: path('id'),
					version: { from: path('v'), order: 'lexical' },
					columns: { a: { type: 'real', from: path('a') } },
				}),
			},
		});
		expect(one.fingerprint).not.toBe(withoutDerived.fingerprint);
		expect(rebuildRelevant(one)).toMatchObject({ derives: ['src'] });
	});
});
