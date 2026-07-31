/**
 * A declaration is validated where it is written, not where it is opened. Every
 * failure below would otherwise surface as a SQL error inside a sync pass.
 */

import { describe, expect, test } from 'bun:test';
import {
	defineMirror,
	derived,
	MirrorDeclarationError,
	path,
	table,
} from '../src/index.ts';

type Thing = { id: string; v: string; a: number };

const source = () =>
	table<Thing>({
		key: path('id'),
		version: { from: path('v'), order: 'lexical' },
		columns: { a: { type: 'real', from: path('a') } },
	});

describe('declaration validation', () => {
	test('a mirror with no tables is not a mirror', () => {
		expect(() => defineMirror({ name: 'x', tables: {} })).toThrow(
			MirrorDeclarationError,
		);
	});

	test('the reserved prefix is refused for tables and columns', () => {
		expect(() =>
			defineMirror({ name: 'x', tables: { _things: source() } }),
		).toThrow(MirrorDeclarationError);
		expect(() =>
			defineMirror({
				name: 'x',
				tables: {
					things: table<Thing>({
						key: path('id'),
						version: { from: path('v'), order: 'lexical' },
						columns: { _raw: { type: 'text', from: path('id') } },
					}),
				},
			}),
		).toThrow(MirrorDeclarationError);
	});

	test('a derived table must name a source that exists and is a source', () => {
		expect(() =>
			defineMirror({
				name: 'x',
				tables: {
					things: source(),
					kids: derived({ of: 'missing', key: 'k', columns: { k: 'text' } }),
				},
				derive: {},
			}),
		).toThrow(MirrorDeclarationError);
	});

	test('a derived table without a derive function can never hold a row', () => {
		expect(() =>
			defineMirror({
				name: 'x',
				tables: {
					things: source(),
					kids: derived({ of: 'things', key: 'k', columns: { k: 'text' } }),
				},
			}),
		).toThrow(MirrorDeclarationError);
	});

	test('a derived key must be one of its own columns', () => {
		expect(() =>
			defineMirror({
				name: 'x',
				tables: {
					things: source(),
					kids: derived({ of: 'things', key: 'nope', columns: { k: 'text' } }),
				},
				derive: { things: () => {} },
			}),
		).toThrow(MirrorDeclarationError);
	});

	test('an index must name columns the table has', () => {
		expect(() =>
			defineMirror({
				name: 'x',
				tables: {
					things: table<Thing>({
						key: path('id'),
						version: { from: path('v'), order: 'lexical' },
						columns: { a: { type: 'real', from: path('a') } },
						indexes: [['b']],
					}),
				},
			}),
		).toThrow(MirrorDeclarationError);
	});
});
