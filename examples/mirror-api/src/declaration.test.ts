import { describe, expect, test } from 'bun:test';
import { defineMirror } from './declaration.ts';

const base = {
	domain: 'test.mirror',
	tables: {
		invoices: {
			columns: {
				total_amt: { type: 'REAL', from: ['TotalAmt'] },
				doc_number: { type: 'TEXT', from: ['DocNumber'] },
			},
			orderBy: { column: 'updated_at', from: ['MetaData', 'LastUpdatedTime'] },
			softDelete: true,
		},
	},
} as const;

describe('the declaration is data, and its canonical form is the rebuild gate', () => {
	test('authoring order does not change the gate', () => {
		const reordered = defineMirror({
			domain: 'test.mirror',
			tables: {
				invoices: {
					softDelete: true,
					orderBy: {
						column: 'updated_at',
						from: ['MetaData', 'LastUpdatedTime'],
					},
					columns: {
						doc_number: { type: 'TEXT', from: ['DocNumber'] },
						total_amt: { type: 'REAL', from: ['TotalAmt'] },
					},
				},
			},
		});

		expect(reordered.canonical).toBe(defineMirror(base).canonical);
	});

	test('indexes are excluded, so a query optimization never forces a re-pull', () => {
		const indexed = defineMirror({
			...base,
			tables: {
				invoices: {
					...base.tables.invoices,
					indexes: { idx_invoices_updated_at: ['updated_at'] },
				},
			},
		});

		expect(indexed.canonical).toBe(defineMirror(base).canonical);
	});

	test('a stored-shape change moves the gate', () => {
		const retyped = defineMirror({
			...base,
			tables: {
				invoices: {
					...base.tables.invoices,
					columns: {
						...base.tables.invoices.columns,
						total_amt: { type: 'TEXT', from: ['TotalAmt'] },
					},
				},
			},
		});
		const materialized = defineMirror({
			...base,
			tables: {
				invoices: {
					...base.tables.invoices,
					columns: {
						...base.tables.invoices.columns,
						total_amt: { type: 'REAL', from: ['TotalAmt'], stored: true },
					},
				},
			},
		});
		const undeleted = defineMirror({
			...base,
			tables: { invoices: { columns: base.tables.invoices.columns } },
		});

		const gate = defineMirror(base).canonical;
		expect(retyped.canonical).not.toBe(gate);
		expect(materialized.canonical).not.toBe(gate);
		expect(undeleted.canonical).not.toBe(gate);
	});

	test('a supplied column moves the gate when its derivation is restamped', () => {
		const declare = (revision: string) =>
			defineMirror({
				domain: 'test.mirror',
				tables: {
					messages: { supplied: { body_text: { type: 'TEXT', revision } } },
				},
			}).canonical;

		expect(declare('v1')).not.toBe(declare('v2'));
	});

	test('the domain namespaces two mirrors that share a shape', () => {
		const books = defineMirror({ ...base, domain: 'books.mirror' });
		const mail = defineMirror({ ...base, domain: 'mail.mirror' });

		expect(books.canonical).not.toBe(mail.canonical);
	});

	test('unsafe or colliding names are refused when the mirror is defined', () => {
		expect(() =>
			defineMirror({
				domain: 'x',
				tables: { 'bad name': {} },
			}),
		).toThrow(/Unsafe table name/);

		expect(() =>
			defineMirror({
				domain: 'x',
				tables: { t: { columns: { raw: { type: 'TEXT', from: ['A'] } } } },
			}),
		).toThrow(/already has it/);

		expect(() =>
			defineMirror({
				domain: 'x',
				tables: {
					t: {
						columns: { a: { type: 'TEXT', from: ['A'] } },
						supplied: { a: { type: 'TEXT', revision: 'v1' } },
					},
				},
			}),
		).toThrow(/both projected and supplied/);

		expect(() =>
			defineMirror({
				domain: 'x',
				tables: { t: { columns: { a: { type: 'TEXT', from: ["A'; DROP"] } } } },
			}),
		).toThrow(/Unsafe path segment/);
	});
});
