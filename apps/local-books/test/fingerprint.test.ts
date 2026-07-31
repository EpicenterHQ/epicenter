import { describe, expect, test } from 'bun:test';
import {
	canonicalizeDeclaration,
	fingerprintDeclaration,
} from '../src/fingerprint.ts';

describe('mirror declaration fingerprints', () => {
	test('canonicalizes object key order without changing the fingerprint', () => {
		const first = {
			tables: { invoices: { columns: ['id', 'total'] } },
			format: 1,
		};
		const second = {
			format: 1,
			tables: { invoices: { columns: ['id', 'total'] } },
		};

		expect(canonicalizeDeclaration(first)).toBe(
			canonicalizeDeclaration(second),
		);
		expect(fingerprintDeclaration('test/v1', first)).toBe(
			fingerprintDeclaration('test/v1', second),
		);
	});

	test('changes when rebuild-relevant declaration data changes', () => {
		const first = { format: 1, columns: [{ name: 'total', type: 'REAL' }] };
		const second = { format: 1, columns: [{ name: 'total', type: 'INTEGER' }] };

		expect(fingerprintDeclaration('test/v1', first)).not.toBe(
			fingerprintDeclaration('test/v1', second),
		);
	});

	test('keeps runtime-only index changes outside the declaration', () => {
		const declaration = {
			format: 1,
			columns: [{ name: 'total', type: 'REAL' }],
		};
		const runtime = {
			...declaration,
			indexes: ['idx_total'],
		};
		const { indexes: _indexes, ...rebuildDeclaration } = runtime;

		// The caller fingerprints only the rebuild declaration. Runtime index
		// changes are intentionally not included in that input.
		expect(fingerprintDeclaration('test/v1', declaration)).toBe(
			fingerprintDeclaration('test/v1', rebuildDeclaration),
		);
	});
});
