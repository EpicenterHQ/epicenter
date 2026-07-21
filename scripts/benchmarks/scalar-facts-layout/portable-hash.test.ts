/**
 * The portable streaming hasher must be byte-identical to the V1 kernel's
 * `sha256Hex` over the same input, and its digest must not depend on how the
 * input was split into chunks. These invariants let the trace drop Bun's
 * `CryptoHasher`/`Buffer` without changing any committed digest.
 */

import { describe, expect, test } from 'bun:test';

import {
	utf8ByteLength as kernelUtf8ByteLength,
	sha256Hex,
} from '../../../packages/data/src/protocol/v1/canonical.js';
import { Sha256Stream, utf8ByteLength } from './portable-hash.js';

const CASES = [
	'',
	'a',
	'abc',
	'the quick brown fox jumps over the lazy dog',
	'€uro\u{1f600} multibyte',
	'x'.repeat(55), // one byte under the single-block padding boundary
	'x'.repeat(56), // exactly at the two-block padding boundary
	'x'.repeat(63),
	'x'.repeat(64), // exactly one block
	'x'.repeat(65),
	'y'.repeat(1000),
	JSON.stringify({ body: 'x'.repeat(300), ordinal: 42, phase: 2 }),
];

describe('byte-identical to the kernel sha256Hex', () => {
	for (const input of CASES) {
		const label =
			input.length > 24
				? `${input.slice(0, 24)}... (${input.length})`
				: JSON.stringify(input);
		test(`matches for ${label}`, () => {
			expect(new Sha256Stream().update(input).digestHex()).toBe(
				sha256Hex(input),
			);
		});
	}
});

describe('chunk-boundary independence', () => {
	test('the digest depends only on concatenated bytes, not chunk splits', () => {
		const whole = `${'y'.repeat(200)}€${'z'.repeat(133)}`;
		const reference = sha256Hex(whole);
		// Split at every boundary from 0..length, including inside the multibyte glyph.
		for (let cut = 0; cut <= whole.length; cut += 7) {
			const hasher = new Sha256Stream();
			hasher.update(whole.slice(0, cut));
			hasher.update(whole.slice(cut));
			expect(hasher.digestHex()).toBe(reference);
		}
	});

	test('many tiny chunks equal one big chunk', () => {
		const whole = 'framed-record|'.repeat(500);
		const chunked = new Sha256Stream();
		for (const ch of whole) chunked.update(ch);
		expect(chunked.digestHex()).toBe(sha256Hex(whole));
	});
});

describe('finalization is one-shot', () => {
	test('update after digest throws', () => {
		const hasher = new Sha256Stream();
		hasher.update('a').digestHex();
		expect(() => hasher.update('b')).toThrow();
	});
	test('a second digest throws', () => {
		const hasher = new Sha256Stream();
		hasher.update('a');
		hasher.digestHex();
		expect(() => hasher.digestHex()).toThrow();
	});
});

describe('utf8ByteLength matches the kernel', () => {
	for (const input of CASES) {
		test(`length for ${JSON.stringify(input.slice(0, 16))}`, () => {
			expect(utf8ByteLength(input)).toBe(kernelUtf8ByteLength(input));
		});
	}
});
