/**
 * Admission control framing tests.
 * Admission and retirement identify the authenticated connection's generation;
 * malformed controls and historical identity opcodes grant no authority.
 */
import { expect, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { decodeFrame, encodeFrame } from './frames.js';

test('admission controls round-trip without a selectable generation payload', () => {
	for (const kind of ['admitted', 'retired'] as const) {
		const bytes = encodeFrame({ kind });
		expect(bytes).toHaveLength(1);
		expect(expectOk(decodeFrame(bytes))).toEqual({ kind });
	}
});

test('extra bytes invalidate admission controls instead of declaring retirement', () => {
	for (const kind of ['admitted', 'retired'] as const) {
		const bytes = new Uint8Array([...encodeFrame({ kind }), 0]);
		expect(expectErr(decodeFrame(bytes)).name).toBe('Malformed');
	}
});

test('historical boundary and identity opcodes remain invalid', () => {
	for (const opcode of [8, 9]) {
		expect(expectErr(decodeFrame(new Uint8Array([opcode]))).name).toBe(
			'Malformed',
		);
	}
});
